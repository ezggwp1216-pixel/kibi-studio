# Kibi Base — нейтральная основа приложения

Этот шаблон не выбирает приложение за пользователя и не содержит готовой
интеграции внешнего сервиса. Цель — один согласованный путь: идея, макет,
приложение, проверка, бинарник и подтверждённая установка на Киби.

## Что сохраняется

Плата DS‑02/ESP32-S3/16MiB, Arduino3.3.12/ESP-IDF5.5.5, дисплей240×296 RGB565,
CST810, Source Sans3, калибровка/NVS, GPIO, power/sleep/wake и разделы flash.
`Feature.h`, `project.ino` и драйверы — защищённый аппаратный адаптер. Код
приложения находится в `app_core.h`, `app_view.h`, `app_feature.h` и изменяется
через разрешённые kibi-инструменты с проверкой SHA.

## Модули и инициализация

- `Feature::begin` приложения готовит только модель. Платформа ещё не готова.
  Аппаратный worker запускается из первого устройственного `Feature::tick`
  или принятого действия после загрузки. UI/input/power loop не блокируется.
- Микрофон есть в обоих вариантах. Без динамика — штатные MicrophoneI2s и
  MicrophonePower::Lifecycle; с динамиком — один DeviceAudio::Session и один
  владеющий им worker. Не занимайте I2S двумя владельцами.
- `preparePlayback()` подготавливает усилитель без PCM и ожидания. Если нужен
  измеренный интервал установления, отсчитывайте его неблокирующе, сохраняя все
  начальные samples. Это не доказательство аналоговой готовности.
- `writeSpeakerMono` подтверждает передачу в DMA, а не прослушивание. STOP от
  сервера, `playing()` и таймер не являются completion fence. Не срезайте хвост
  немедленным `stopPlayback`; полный ACK допустим только с аппаратным основанием.
- Тач и +/− приходят через существующий portable Input/reducer. Cancel не Tap.
  Не читайте CST810 или GPIO повторно в feature-коде; не придумывайте power GPIO.
- Батарея уже измерена платформой. Копируйте `StateInfoDetail::runtime.info`
  в Model из device tick; `batteryPercent == -1` означает неизвестное/устаревшее.
  `chargingKnown=false` не разрешает рисовать подтверждённую зарядку.
- Wi-Fi запускается платформой после ADC2. Используйте только API, реально
  присутствующий в этом заголовке и metadata. Старый beginWifi и новый DeviceWifi
  — разные поколения контракта. HTTPS выполняется в worker, не в renderer/tick.
- Legacy PCM/job voice helpers не реализуют новый Opus WebSocket протокол сервера.
  Читайте его актуальный hello/features и отдельный контракт, а не угадывайте.

Полный [аппаратный контракт](https://sldvkibi.ru/server/docs/HARDWARE.md),
[инструкция локальной Studio](https://sldvkibi.ru/server/docs/LOCAL_STUDIO.md) и
[описание SDK](https://sldvkibi.ru/server/docs/SDK.md) доступны без секретов.

## Проверки готовности

SDK doctor проверяет совместимость публичных файлов/metadata/manifest; он не
проверяет физическое железо. Native preview проверяет общие state/input/pixels.
Target compile проверяет реальный ESP32 toolchain с тестовой конфигурацией.
Микрофон, звук, радио, аккумулятор, сон и касания проверяются отдельно на плате.
Секреты не помещаются в исходники, чат, экспорт или журнал. Любая смена исходников,
настроек или SDK делает предыдущие результаты и бинарник устаревшими.

Сначала согласуйте управление, все экраны и читаемость, затем проверяйте
offline/loading/error/retry/cancel, повторные start/stop и память при длительной
работе. Прошивка устанавливается только последним подтверждённым USB-действием.

Ниже сохранены действующие инструкции шрифтов и полная лицензия OFL.


# Shared Kibi typography — Source Sans 3

Use **Source Sans 3 for every user project**. This is the exact variable source
used by Kibi Pro, with native grayscale AA4 masks at each size. Choose your own
colors and layout. Never enlarge the old 20px bitmap to create a price or heading.

Include `kibi_typography.h` explicitly. It renders into an existing, native
RGB565 `uint16_t` framebuffer; it does not allocate one or touch LCD/GPIO/USB.
The stock base UI is unchanged until your feature calls this optional helper.

| `Font` | Native size / weight | Use |
|---|---|---|
| `Body18` | 18px / Regular400 | Body, secondary information, labels |
| `Medium20` | 20px / Medium500 | Emphasis, compact controls |
| `Header20` | 20px / Semibold600 | Short headings |
| `Number32` / `Number40` / `Number48` | 32/40/48px / Semibold600 | Prices and prominent numbers |

Body faces retain all 309 stock Latin/Russian/Vietnamese characters and add
`€ ₽ −`. The large faces contain exactly ` $%()+,-./:0123456789?` plus NBSP,
`€ ₽ −`; use a body face for labels such as USD/BTC. Existing Vietnamese font
fallback files remain available and unchanged. Text is UTF-8; unsupported or
malformed codepoints render as `?`. This renderer is for a single line: LF ends
the line and CR is ignored. Apply your own wrapping with measured widths.

```cpp
#include "kibi_typography.h"

void drawPrice(uint16_t* pixels) {  // Obtain through the stock display API.
  using namespace KibiTypography;
  Framebuffer frame{pixels, size_t(240)*296, 240, 296, 240};
  draw(frame, getFace(Font::Medium20), u8"Цена / USD", 16, 24, 0xA514);
  const std::string_view price="$1,000,000";
  const Face* face=largestNumberThatFits(price,208,60);
  if(face) { // 40px: 190px wide; 48px would be 226px and would not fit.
    const int x=16+(208-width(*face,price))/2;
    draw(frame,*face,price,x,72,0xFFFF,{16,72,208,64});
  } else {
    // Choose an explicit smaller layout; never silently truncate a price.
    draw(frame,getFace(Font::Medium20),price,16,72,0xFFFF);
  }
}
```

Coordinates are native pixels. `draw`'s y is the top of the complete font line
box; its baseline is `y+face.ascent`. `measure` returns 1/64px advance, exact ink
bounds relative to that top, and a pixel width including overhangs. A clip is
`{x,y,width,height}`, not its bottom-right corner. `largestNumberThatFits`
tries 48,40,32px, checks actual text width and the full face line height, and
returns `nullptr` when no supplied size fits or the text is unsupported/empty.
The framebuffer's `pixelCount` must describe the accessible backing storage;
`stride` is in pixels. Negative/extreme coordinates and clips are safely
intersected before any indexing. Colors are ordinary native RGB565, not
byte-swapped SPI words; each AA4 coverage blends against its existing pixel.

No pair kerning table is added: the helpers use native FreeType hinted glyph
advances, including tabular digits. This is deliberately small and predictable
for UI/price layout, not a complex-script shaping engine. New faces total
84,596 bytes of glyph/mask flash payload, plus face metadata/code/alignment,
with no font cache, heap allocation or runtime TTF parsing.

The **full source/typography kit** includes `assets/fonts/SourceSans3.ttf`,
`SourceSans3-OFL.txt` and `tools/build_kibi_typography.py`. The **lean upload**
contains only the two prepared headers and this guide alongside the sketch:
do not upload the TTF, scripts, SDK, libraries, partitions or binaries.

Regenerate using Pillow13.0.0 / FreeType2.14.3:

```sh
python3 tools/build_kibi_typography.py --check
```

From the repository use `firmware/tools/build_kibi_typography.py` instead.
The command validates both the original font and OFL hashes, then checks every
generated byte. Font source SHA-256:
`042fe2cc0b933e328410d7acbd0aa6a1873dca5aef81875f4bc214b08825c7b9`.
OFL SHA-256:
`09746787287a289323b0ec3cff4d1a4a801331b82b7207c1e186f5d26619a392`.


## Complete Source Sans 3 font license

Copyright 2010-2020 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'. All Rights Reserved. Source is a trademark of Adobe in the United States and/or other countries.

This Font Software is licensed under the SIL Open Font License, Version 1.1.

This license is copied below, and is also available with a FAQ at: http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded, 
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
