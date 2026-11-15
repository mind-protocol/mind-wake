//! One lossless sample of the primary screen for the opted-in voice composer.
#[tauri::command]
pub async fn voice_screen_sample() -> Result<serde_json::Value, String> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(windows::sample)
            .await
            .map_err(|error| error.to_string())?
    }
    #[cfg(not(windows))]
    Err("Capture vocale disponible sur Windows".into())
}

#[cfg(windows)]
mod windows {
    use std::ffi::c_void;
    use std::ptr::null_mut;
    use std::sync::Mutex;

    type Handle = *mut c_void;
    const UNAVAILABLE: &str = "Capture de l’écran principal indisponible";
    static CAPTURE: Mutex<()> = Mutex::new(());

    #[repr(C)]
    struct BitmapHeader {
        size: u32,
        width: i32,
        height: i32,
        planes: u16,
        bits: u16,
        remaining: [u32; 6],
    }

    #[repr(C)]
    #[derive(Default)]
    struct SystemTime {
        year: u16,
        month: u16,
        day_of_week: u16,
        day: u16,
        hour: u16,
        minute: u16,
        second: u16,
        milliseconds: u16,
    }

    #[link(name = "user32")]
    unsafe extern "system" {
        fn OpenInputDesktop(flags: u32, inherit: i32, access: u32) -> Handle;
        fn CloseDesktop(desktop: Handle) -> i32;
        fn GetUserObjectInformationW(
            object: Handle,
            index: i32,
            value: Handle,
            length: u32,
            needed: *mut u32,
        ) -> i32;
        fn GetSystemMetrics(index: i32) -> i32;
        fn GetDC(window: Handle) -> Handle;
        fn ReleaseDC(window: Handle, dc: Handle) -> i32;
    }

    #[link(name = "gdi32")]
    unsafe extern "system" {
        fn CreateCompatibleDC(dc: Handle) -> Handle;
        fn DeleteDC(dc: Handle) -> i32;
        fn CreateDIBSection(
            dc: Handle,
            info: *const BitmapHeader,
            usage: u32,
            bits: *mut Handle,
            section: Handle,
            offset: u32,
        ) -> Handle;
        fn SelectObject(dc: Handle, object: Handle) -> Handle;
        fn DeleteObject(object: Handle) -> i32;
        fn StretchBlt(
            dst: Handle,
            dx: i32,
            dy: i32,
            dw: i32,
            dh: i32,
            src: Handle,
            sx: i32,
            sy: i32,
            sw: i32,
            sh: i32,
            op: u32,
        ) -> i32;
        fn GdiFlush() -> i32;
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetSystemTime(time: *mut SystemTime);
    }

    fn unlocked() -> bool {
        // Same desktop check as the existing Windows screenshot helper.
        let desktop = unsafe { OpenInputDesktop(0, 0, 1) };
        if desktop.is_null() {
            return false;
        }
        let mut name = [0u16; 256];
        let mut needed = 0;
        let ok = unsafe {
            let ok =
                GetUserObjectInformationW(desktop, 2, name.as_mut_ptr().cast(), 512, &mut needed);
            CloseDesktop(desktop);
            ok
        };
        ok != 0 && name[..8] == [68, 101, 102, 97, 117, 108, 116, 0]
    }

    fn capture_time() -> String {
        let mut time = SystemTime::default();
        unsafe { GetSystemTime(&mut time) };
        format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
            time.year, time.month, time.day, time.hour, time.minute, time.second, time.milliseconds
        )
    }

    fn read_screen() -> Result<(Vec<u8>, u32, u32, String), &'static str> {
        let (source_width, source_height) = unsafe { (GetSystemMetrics(0), GetSystemMetrics(1)) };
        if source_width <= 0
            || source_height <= 0
            || i64::from(source_width) * i64::from(source_height) > 40_000_000
        {
            return Err(UNAVAILABLE);
        }
        let longest = source_width.max(source_height);
        let scaled = |side: i32| {
            // Leave room for the composer’s timestamp strip on a portrait capture.
            (i64::from(side) * i64::from(longest.min(1248)) / i64::from(longest)).max(1) as i32
        };
        let (width, height) = (scaled(source_width), scaled(source_height));
        let header = BitmapHeader {
            size: std::mem::size_of::<BitmapHeader>() as u32,
            width,
            height: -height, // Top-down, so composer coordinates match the screen.
            planes: 1,
            bits: 32,
            remaining: [0; 6],
        };
        // The primary display starts at (0, 0) in virtual screen coordinates.
        unsafe {
            let screen = GetDC(null_mut());
            if screen.is_null() {
                return Err(UNAVAILABLE);
            }
            let target = CreateCompatibleDC(screen);
            let result = (|| {
                if target.is_null() {
                    return Err(UNAVAILABLE);
                }
                let mut pixels = null_mut();
                let bitmap = CreateDIBSection(target, &header, 0, &mut pixels, null_mut(), 0);
                if bitmap.is_null() {
                    return Err(UNAVAILABLE);
                }
                let previous = SelectObject(target, bitmap);
                let selected = !previous.is_null() && previous as isize != -1;
                let copied = selected
                    && !pixels.is_null()
                    && StretchBlt(
                        target,
                        0,
                        0,
                        width,
                        height,
                        screen,
                        0,
                        0,
                        source_width,
                        source_height,
                        0x40CC0020, // SRCCOPY | CAPTUREBLT includes layered menus.
                    ) != 0
                    && GdiFlush() != 0;
                let frame = if copied {
                    let at = capture_time();
                    let bgra = std::slice::from_raw_parts(
                        pixels.cast::<u8>(),
                        (width * height * 4) as usize,
                    );
                    let mut rgb = Vec::with_capacity((width * height * 3) as usize);
                    for pixel in bgra.chunks_exact(4) {
                        rgb.extend_from_slice(&[pixel[2], pixel[1], pixel[0]]);
                    }
                    Ok((rgb, width as u32, height as u32, at))
                } else {
                    Err(UNAVAILABLE)
                };
                if selected {
                    SelectObject(target, previous);
                }
                DeleteObject(bitmap);
                frame
            })();
            if !target.is_null() {
                DeleteDC(target);
            }
            ReleaseDC(null_mut(), screen);
            result
        }
    }

    pub fn sample() -> Result<serde_json::Value, String> {
        let _capture = CAPTURE.try_lock().map_err(|_| UNAVAILABLE)?;
        if !unlocked() {
            return Err(UNAVAILABLE.into());
        }
        let (rgb, width, height, at) = read_screen()?;
        let mut png = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut png, width, height);
            encoder.set_color(png::ColorType::Rgb);
            encoder.set_compression(png::Compression::Fast);
            encoder
                .write_header()
                .and_then(|mut writer| writer.write_image_data(&rgb))
                .map_err(|error| error.to_string())?;
        }
        if !unlocked() {
            return Err(UNAVAILABLE.into());
        }
        Ok(serde_json::json!({
            "base64": crate::conversation_images::base64(&png),
            "capturedAt": at,
            "mediaType": "image/png",
        }))
    }
}
