"""Convert screenshots to spatial Unicode text. Requires Pillow and NumPy."""
import argparse
from pathlib import Path
import sys
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "services" / "mcp"))
from capture_unicode_core import convert


def window():
    root = tk.Tk()
    root.title("Capture → Unicode")
    root.geometry("1080x720")
    bar = ttk.Frame(root, padding=8)
    bar.pack(fill="x")
    path = None
    width = tk.StringVar(value="200")
    mode = tk.StringVar(value="Automatique")
    ocr = tk.BooleanVar(value=True)
    simplified = tk.BooleanVar(value=False)
    modes = {"Automatique": "auto", "Fond clair": "light", "Fond sombre": "dark"}
    status = tk.StringVar(value="Ouvrez une capture pour la convertir.")
    result = tk.Text(root, wrap="none", font=("Consolas", 9))
    def render():
        if path is None:
            return
        try:
            output = convert(path, int(width.get()), modes[mode.get()], ocr.get(), simplified.get())
        except (ValueError, OSError) as exc:
            messagebox.showerror("Conversion", str(exc))
            return
        result.configure(state="normal")
        result.delete("1.0", "end")
        result.insert("1.0", output)
        result.configure(state="disabled")
        status.set(f"{Path(path).name}  ·  {width.get()} colonnes × {len(output.splitlines())} lignes")
    def choose():
        nonlocal path
        selected = filedialog.askopenfilename(filetypes=[("Images", "*.png *.jpg *.jpeg *.webp *.bmp"), ("Tous", "*")])
        if selected:
            path = selected
            render()
    def save():
        data = result.get("1.0", "end-1c")
        if data:
            dest = filedialog.asksaveasfilename(defaultextension=".txt")
            if dest:
                Path(dest).write_text(data, encoding="utf-8")
    ttk.Button(bar, text="Ouvrir une capture", command=choose).pack(side="left")
    ttk.Label(bar, text="Colonnes").pack(side="left", padx=8)
    ttk.Spinbox(bar, from_=16, to=800, width=5, textvariable=width).pack(side="left")
    ttk.Combobox(bar, values=list(modes), state="readonly", textvariable=mode, width=14).pack(side="left", padx=8)
    ttk.Button(bar, text="Convertir", command=render).pack(side="left")
    ttk.Checkbutton(bar, text="OCR", variable=ocr, command=render).pack(side="left")
    ttk.Checkbutton(bar, text="Mode simplifié", variable=simplified, command=render).pack(side="left")
    ttk.Button(bar, text="Exporter en .txt", command=save).pack(side="right")
    ttk.Label(root, textvariable=status, padding=6).pack(side="bottom", fill="x")
    for orient, side, fill, view in [("horizontal","bottom","x",result.xview), ("vertical","right","y",result.yview)]:
        scroll = ttk.Scrollbar(root, orient=orient, command=view)
        scroll.pack(side=side, fill=fill)
        result.configure(**{("xscrollcommand" if fill == "x" else "yscrollcommand"): scroll.set})
    result.pack(expand=True, fill="both")
    root.mainloop()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", nargs="?")
    parser.add_argument("--columns", type=int, default=200)
    parser.add_argument("--no-ocr", action="store_true", help="Rendu visuel seul")
    parser.add_argument("--simplified", action="store_true", help="Conserver le texte et les grands contours")
    parser.add_argument("--background", choices=["auto", "light", "dark"], default="auto")
    parser.add_argument("-o", "--output", type=Path)
    args = parser.parse_args()
    if args.image is None:
        window()
    else:
        import sys
        try:
            data = convert(args.image, args.columns, args.background, not args.no_ocr, args.simplified)
            if args.output:
                args.output.write_text(data, encoding="utf-8")
            else:
                sys.stdout.buffer.write((data + "\n").encode("utf-8"))
        except (ValueError, OSError) as error:
            parser.exit(1, f"{error}\n")
