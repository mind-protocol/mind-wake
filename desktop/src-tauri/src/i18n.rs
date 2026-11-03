use std::sync::atomic::{AtomicBool, Ordering};

static FRENCH: AtomicBool = AtomicBool::new(false);

pub fn set_language(language: &str) {
    FRENCH.store(language == "fr", Ordering::Relaxed);
}

pub fn text(french: &'static str, english: &'static str) -> &'static str {
    if FRENCH.load(Ordering::Relaxed) { french } else { english }
}
