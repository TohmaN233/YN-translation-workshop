# PDF export font

`NotoSansSC-Regular.ttf` is a static weight-400 instance of Google Fonts' Noto Sans SC variable font:

https://github.com/google/fonts/blob/main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf

License: SIL Open Font License 1.1, included in `OFL.txt`. Copyright 2014–2021 Adobe, reserved font name Source.

Generated with fontTools 4.60.1:

```python
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
font = TTFont("NotoSansSC[wght].ttf")
instantiateVariableFont(font, {"wght": 400}, inplace=True).save("NotoSansSC-Regular.ttf")
```

Static font SHA256: `8d3ab552c1aa03ad0d752aef470474b9ce0a57ab1b76f67d115119479cb8203b`.

The complete font is embedded: pdf-lib/fontkit subset output did not preserve all Chinese glyphs in Poppler verification.
