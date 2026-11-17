import unittest

from PIL import Image

from desktop_clickables import annotate, _number_controls


class NumberedControlTests(unittest.TestCase):
    def test_repeated_text_in_reading_order_and_case_sensitive(self):
        labels = ["New chat", "New chat", "new chat", "New chat"]
        lines = [list(f"[{label}]".ljust(16)) for label in labels]
        controls = [(i, 0, len(label)+2, 4, 20*i, 90, 20*i+18) for i,label in enumerate(labels)]
        mapped = _number_controls(lines, controls[::-1], [])
        self.assertEqual(["".join(line).strip() for line in lines],
                         ["[New chat #1]", "[New chat #2]", "[new chat]", "[New chat #3]"])
        for r,a,b,*box in mapped:
            self.assertEqual(tuple(box), controls[r][3:])
            self.assertEqual("".join(lines[r][a:b]), "".join(lines[r]).strip())
    def test_annotate_preserves_literal_text_and_click_rectangles(self):
        image = Image.new("RGB", (280, 40), "white")
        grid = ["    +      +       [+1]     ", "                    ×       "]
        words = [
            (0, 4, 5, 42, 4, 48, 14),
            (0, 11, 12, 112, 4, 118, 14),
            (1, 20, 21, 202, 24, 208, 34),
            (0, 19, 23, 190, 4, 228, 15),
        ]
        targets = [(40, 0, 50, 20, "Add"), (110, 0, 120, 20, "Add"), (200, 20, 210, 40, "Close")]
        expected, spans, controls = annotate(grid, words, image, targets[::-1])
        self.assertEqual(annotate(grid, words, image, targets), (expected, spans, controls))
        self.assertEqual(len(expected[0]), len(grid[0]))
        self.assertEqual(expected[0][19:23], "[+1]")
        self.assertEqual({expected[r][a:b]: box for r,a,b,*box in controls},
                         {"[+ #1]": [40,0,50,20], "[+ #2]": [110,0,120,20], "[×]": [200,20,210,40]})
        self.assertTrue(all(c in spans for c in controls))
        self.assertIn(words[-1], spans)

    def test_multi_digit_number_and_existing_clickable_label(self):
        lines = [list(("[+] " * 10).ljust(70) + "[+ #1]")]
        controls = [(0, n*4, n*4+3, n*8, 0, n*8+6, 6) for n in range(10)]
        controls.append((0, 70, 76, 85, 0, 90, 8))
        mapped = _number_controls(lines, controls, [])
        labels = ["".join(lines[r][a:b]) for r,a,b,*_ in mapped]
        self.assertEqual(labels, [f"[+ #{n}]" for n in range(2,12)] + ["[+ #1]"])
        self.assertEqual([s[3:] for s in mapped], [s[3:] for s in controls])

    def test_full_grid_retains_two_distinct_clickable_aliases(self):
        lines = [list("[+][+]")]
        controls = [(0,0,3,0,0,4,4), (0,3,6,10,0,14,4)]
        mapped = _number_controls(lines, controls, [])
        self.assertEqual("".join(lines[0]), "[①][②]")
        self.assertEqual(mapped, controls)


if __name__ == "__main__":
    unittest.main()
