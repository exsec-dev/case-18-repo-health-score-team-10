# report-check.py — приемка PDF по отрисованному результату (В4.9, Б8).
#
#   python scripts/report-check.py <file.pdf> [<file.pdf> ...]
#
# Для каждого PDF рядом должен лежать MD того же отчета (scripts/report-pdf.ts
# пишет оба). Проверки по ТЕКСТОВОМУ СЛОЮ отрисованного PDF (PyMuPDF), а не по
# описанию документа до верстки — урок В4.7 и находка Б3 В4.9 (неразрывный
# блок с заголовком терял текст, описание документа при этом было полным):
#   1. каждое слово MD есть в тексте PDF (ничего не потеряно версткой);
#   2. ни один блок текста не выходит за поля страницы (48 pt слева/справа);
#   3. пустых страниц нет (только колонтитулы).
# Код выхода 1 — если хоть одна проверка не прошла.
import re
import sys

import fitz  # PyMuPDF

WORD = re.compile(r"[^\W_]+", re.UNICODE)
MARGIN = 48 - 1.5  # поля страницы с допуском на сглаживание глифов


def words(text: str) -> list[str]:
    return [w.lower() for w in WORD.findall(text.replace("​", ""))]


def md_words(md: str) -> list[str]:
    md = re.sub(r"\]\([^)]*\)", "]", md).replace("&lt;", "<").replace("&gt;", ">")
    return words(md)


failed = False
for path in sys.argv[1:]:
    doc = fitz.open(path)
    pdf_text = "\n".join(page.get_text() for page in doc)
    pdf_set = set(words(pdf_text))
    # длинные значения PDF переносит точками переноса — такой токен режется на части
    joined = "".join(words(pdf_text))
    md = open(path[: -len(".pdf")] + ".md", encoding="utf-8").read()
    missing = sorted({w for w in md_words(md) if w not in pdf_set and w not in joined})
    overflow = []
    blank = []
    for i, page in enumerate(doc):
        width = page.rect.width
        lines = [ln for ln in page.get_text().strip().split("\n") if ln.strip()]
        if len(lines) <= 4:
            blank.append(i + 1)
        # по словам, а не по блокам: рамка блока включает пробел в конце
        # перенесенной строки (≈ 2,4 pt), это не выход текста за поле
        for x0, y0, x1, y1, text, *_ in page.get_text("words"):
            if text.strip() and (x0 < MARGIN or x1 > width - MARGIN):
                overflow.append((i + 1, round(x0, 1), round(x1, 1), text.strip()[:40]))
    ok = not missing and not overflow and not blank
    failed = failed or not ok
    print(f"{'OK  ' if ok else 'FAIL'} {path}: страниц {len(doc)}, слов MD {len(md_words(md))}, потеряно {len(missing)}, за полями {len(overflow)}, пустых {len(blank)}")
    for w in missing[:20]:
        print(f"     потеряно: {w}")
    for o in overflow[:10]:
        print(f"     за полями: стр. {o[0]} x {o[1]}-{o[2]} «{o[3]}»")
    if blank:
        print(f"     пустые страницы: {blank}")
sys.exit(1 if failed else 0)
