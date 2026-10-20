#!/usr/bin/env python3
"""Build a synthetic exam paper and mark scheme (PDF) for testing the extractor.

  python3 tests/make_fixture.py OUT_DIR   -> OUT_DIR/paper.pdf, OUT_DIR/scheme.pdf

All questions are invented for this project; no real exam content. Needs reportlab.
Layout mimics a Cambridge MCQ paper: cover page, question numbers in the left margin,
options A-D, diagrams, a question split across a page break, and a blank last page.
"""
import os
import sys

from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

W, H = A4
NUM_X, TEXT_X, OPT_X = 50, 80, 100


class Paper:
    def __init__(self, path):
        self.c = canvas.Canvas(path, pagesize=A4)
        self.page = 1
        self.y = 0

    def new_page(self):
        self.c.showPage()
        self.page += 1
        self.c.setFont("Helvetica", 9)
        self.c.drawCentredString(W / 2, H - 30, str(self.page))
        self.c.drawString(TEXT_X, 30, "SYNTHETIC/01  Practice paper for software testing only")
        self.y = H - 80

    def question(self, n, lines, options):
        c = self.c
        c.setFont("Helvetica-Bold", 11)
        c.drawString(NUM_X, self.y, str(n))
        c.setFont("Helvetica", 11)
        for line in lines:
            c.drawString(TEXT_X, self.y, line)
            self.y -= 16
        self.y -= 6
        self.options(options)
        self.y -= 26

    def options(self, options):
        for key, text in zip("ABCD", options):
            self.c.setFont("Helvetica-Bold", 11)
            self.c.drawString(OPT_X, self.y, key)
            self.c.setFont("Helvetica", 11)
            self.c.drawString(OPT_X + 20, self.y, text)
            self.y -= 18


def ramp(c, x, y):
    """Block on a 30 degree slope."""
    c.setLineWidth(1.2)
    c.line(x, y, x + 200, y)
    c.line(x + 200, y, x + 200, y + 115)
    c.line(x, y, x + 200, y + 115)
    c.saveState()
    c.translate(x + 110, y + 63)
    c.rotate(30)
    c.rect(-18, 0, 36, 24)
    c.restoreState()
    c.setFont("Helvetica", 10)
    c.drawString(x + 30, y + 5, "30°")
    c.drawString(x + 10, y + 95, "block, weight 20 N")


def circuit(c, x, y):
    """12 V cell in series with 2.0 and 4.0 ohm resistors."""
    c.setLineWidth(1.2)
    c.rect(x, y, 220, 90)
    c.setFillColorRGB(1, 1, 1)
    c.rect(x + 40, y + 82, 50, 16, fill=1)
    c.rect(x + 130, y + 82, 50, 16, fill=1)
    c.rect(x + 95, y - 8, 30, 16, fill=1, stroke=0)
    c.setFillColorRGB(0, 0, 0)
    c.line(x + 104, y - 12, x + 104, y + 12)
    c.line(x + 116, y - 6, x + 116, y + 6)
    c.setFont("Helvetica", 10)
    c.drawString(x + 50, y + 104, "2.0 Ω")
    c.drawString(x + 140, y + 104, "4.0 Ω")
    c.drawString(x + 97, y - 26, "12 V")


def table(c, x, y, rows):
    c.setFont("Helvetica", 11)
    for i, row in enumerate(rows):
        for j, cell in enumerate(row):
            c.drawString(x + j * 120, y - i * 18, cell)


def paper(path):
    p = Paper(path)
    c = p.c
    c.setFont("Helvetica-Bold", 18)
    c.drawCentredString(W / 2, H - 200, "Synthetic Physics")
    c.setFont("Helvetica", 12)
    c.drawCentredString(W / 2, H - 230, "Multiple Choice Practice Paper (invented questions)")
    c.drawCentredString(W / 2, H - 260, "This paper has 8 questions. Time: 15 minutes.")
    p.new_page()
    p.question(1, ["Which quantity is an SI base quantity?"], ["force", "energy", "electric current", "voltage"])
    p.question(2, ["The diagram shows a block of weight 20 N at rest on a slope inclined at 30°",
                   "to the horizontal."], [])
    p.y += 32
    ramp(c, TEXT_X + 40, p.y - 140)
    p.y -= 160
    p.c.setFont("Helvetica", 11)
    p.c.drawString(TEXT_X, p.y, "What is the component of the weight parallel to the slope?")
    p.y -= 22
    p.options(["10 N", "17 N", "20 N", "40 N"])
    p.y -= 26
    p.question(3, ["A car accelerates uniformly from rest to 20 m s⁻¹ in 5.0 s.",
                   "How far does it travel in this time?"], ["4.0 m", "50 m", "100 m", "200 m"])
    p.new_page()
    p.question(4, ["A 12 V supply of negligible internal resistance is connected to two resistors",
                   "in series, as shown."], [])
    p.y += 32
    circuit(c, TEXT_X + 60, p.y - 110)
    p.y -= 150
    p.c.setFont("Helvetica", 11)
    p.c.drawString(TEXT_X, p.y, "What is the potential difference across the 4.0 Ω resistor?")
    p.y -= 22
    p.options(["4.0 V", "6.0 V", "8.0 V", "12 V"])
    p.y -= 26
    p.question(5, ["A sound wave has speed 340 m s⁻¹ and frequency 170 Hz.",
                   "What is its wavelength?"], ["0.50 m", "2.0 m", "170 m", "57 800 m"])
    c.setFont("Helvetica-Bold", 11)
    c.drawString(NUM_X, p.y, "6")
    c.setFont("Helvetica", 11)
    c.drawString(TEXT_X, p.y, "Which row correctly classifies the two quantities?")
    p.new_page()  # question 6 continues on the next page
    table(c, OPT_X, p.y, [["", "speed", "acceleration"], ["A", "scalar", "scalar"], ["B", "scalar", "vector"],
                          ["C", "vector", "scalar"], ["D", "vector", "vector"]])
    p.y -= 5 * 18 + 30
    p.question(7, ["An object of mass 2.0 kg has a volume of 0.50 m³. What is its density?"],
               ["0.25 kg m⁻³", "1.0 kg m⁻³", "2.5 kg m⁻³", "4.0 kg m⁻³"])
    p.question(8, ["A steady current of 0.20 A flows for 60 s.", "How much charge passes?"],
               ["3.0 C", "12 C", "300 C", "0.0033 C"])
    p.new_page()
    c.setFont("Helvetica-Bold", 14)
    c.drawCentredString(W / 2, H / 2, "BLANK PAGE")
    c.save()


ANSWERS = "CABCBBDB"


def scheme(path):
    c = canvas.Canvas(path, pagesize=A4)
    c.setFont("Helvetica-Bold", 12)
    c.drawString(80, H - 80, "Synthetic Physics - Mark Scheme")
    c.drawString(80, H - 120, "Question    Answer    Marks")
    c.setFont("Helvetica", 12)
    for i, key in enumerate(ANSWERS):
        y = H - 145 - i * 20
        c.drawString(100, y, str(i + 1))
        c.drawString(165, y, key)
        c.drawString(230, y, "1")
    c.save()


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "build/fixture"
    os.makedirs(out, exist_ok=True)
    paper(os.path.join(out, "paper.pdf"))
    scheme(os.path.join(out, "scheme.pdf"))
    print(f"wrote {out}/paper.pdf and {out}/scheme.pdf")
