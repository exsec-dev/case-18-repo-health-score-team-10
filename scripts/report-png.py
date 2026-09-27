# report-png.py — страницы PDF-отчета в PNG, чтобы смотреть отрисованный результат.
# Через PyMuPDF (`python -c "import fitz"`): headless Chrome дает пустой снимок.
#
#   python scripts/report-png.py <file.pdf> [<file.pdf> ...]
#
# Рядом с каждым PDF кладутся <имя>-p<N>.png (150 dpi); в stdout — пути.
import sys

import fitz  # PyMuPDF

for path in sys.argv[1:]:
    doc = fitz.open(path)
    for i, page in enumerate(doc):
        out = path[: -len(".pdf")] + f"-p{i + 1}.png"
        page.get_pixmap(dpi=110).save(out)
        print(out)
