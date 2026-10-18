// VERSION: 3.13.0
// main.js — сбор картинки капчи со стены item_frame'ов + ЛОКАЛЬНОЕ распознавание цифр
//
// ============ ЧТО ИСПРАВЛЕНО В v3.13.0 (по вашему логу 21:19) ============
// P1. «socks fail: Socks5 proxy rejected connection - ConnectionRefused».
//     Мобильный прокси (bproxy.site:23750, MobileProxy.Space) НЕ принимал TCP —
//     порт никто не слушал: аренда истекла / оборудование выключено / неверный порт.
//     Это НЕ баг бота, но раньше он в такой ситуации: (а) молча показывал «IP ?»,
//     потому что спрашивал IP через тот же мёртвый прокси; (б) жёг 6 ротаций IP
//     впустую; (в) не объяснял, что делать. Теперь:
//       • встроенный SOCKS5-клиент (не зависит от модуля socks) с понятными ошибками;
//       • ИП определяется и НАПРЯМУЮ, когда прокси мёртв (в логе больше нет «?»);
//       • при ConnectionRefused в лог печатается пошаговая инструкция (что проверить);
//       • node main.js --proxy-check — полная диагностика: DNS, SOCKS5, HTTP-резерв,
//         внешний IP, ссылка смены IP, пинг MC-сервера и ВЕРДИКТ с причиной.
// P2. «changeIp: direct:200 body=<!DOCTYPE html>...» — ссылка смены IP вернула
//     ВЕБ-СТРАНИЦУ, а не ответ API. Значит IP фактически НЕ менялся (провайдеру
//     нужен формат API). Теперь:
//       • к ссылке автоматически дописывается format=json;
//       • ответ разбирается: {"status":"OK","new_ip":...,"rt":...} / лимит «30 сек» /
//         HTML / текст — и в лог пишется ЧТО ИМЕННО вернулось и что делать;
//       • если пришёл HTML — явное предупреждение «IP так не меняется, возьмите ссылку
//         из панели "Мои прокси" → колонка "Смена IP"».
// P3. Резервный хост прокси: у MobileProxy.Space один порт слушают и bproxy.site
//     (SOCKS5), и mproxy.site (HTTP). Бот пробует оба + запоминает живой, так что
//     временный отказ одного хоста больше не рвёт весь забег.
// P4. Лимит 30 секунд между сменами IP учитывается (раньше частые запросы молча
//     отбрасывались провайдером, и бот писал «IP не сменился» без причины).
//
// ============ ЧТО ИСПРАВЛЕНО В v3.12.0 (по вашему логу 13:01–19:54) ============
// G1. ГЛАВНОЕ: СЕГМЕНТАЦИЯ РЕЗАЛА НЕ ЦИФРЫ — И ЭТО ОТРАВЛЯЛО БАЗУ.
//     Лог 17:38–17:46: каждый раунд «цифр=5/5», размечено 5, база выросла до 270,
//     но MLP дала 84% train / 10% holdout и предсказания «88888», «44444»,
//     «50000», «33333». Диагноз: рамки находились, а внутри них был фон/шум —
//     признаки описывали шум, модель его запоминала. 270 примеров впустую.
//     Теперь:
//       (а) «вырожденная» нарезка ловится на месте: если >=60% пар кропов почти
//           идентичны — segDegenerate=true, В БАЗУ ТАКОЕ НЕ ПИШЕТСЯ, в чат идёт
//           🧨 с инструкцией, в лог — подробная строка;
//       (б) равномерная нарезка (ДП не нашёл ровно 5 сегментов и порезал «на
//           глазок») штрафуется на 55 баллов — раньше именно она выигрывала и
//           давала симптом «5/5 + 88888»;
//       (в) ОФЛАЙН-ТЮНИНГ: node main.js --autotune [--apply] перебирает все ~50
//           стратегий масок на УЖЕ СОХРАНЁННЫХ картинках и выбирает ту, у которой
//           лучшая честная точность (leave-one-image-out k-NN) по ВАШИМ ответам.
//           Новых подключений к серверу не нужно.
//       (г) node main.js --diag — по картинке показывает топ-10 стратегий, рисует
//           рамки (DIAG_boxes_*.png) и печатает ASCII-кропы: сразу видно, цифра
//           внутри или шум. В чате то же самое делает команда /diag.
// G2. ОТВЕТЫ ЧЕЛОВЕКА СОХРАНЯЮТСЯ (learn/answers.jsonl): раунд, цифры, каталог,
//     какая маска была, что ответил YOLO/локальная модель. Это «золотая» разметка,
//     на ней работают --autotune и --apply (пересбор базы офлайн). Ответ пишется
//     ДАЖЕ если вырезать глифы не удалось — картинка всё равно ценна.
// G3. СТАРЫЕ ОТВЕТЫ ИМПОРТИРУЮТСЯ ИЗ ЛОГА:
//       node main.js --import-answers learn\telegram.log
//     Парсер понимает «раунд 3: ответ «40242» (update_id=785300514)» и ЗАЩИЩАЕТСЯ
//     от «призрачных» апдейтов: если update_id уже встречался в прошлой сессии —
//     ответ отбрасывается. В вашем логе 14:04:41 раунд 1 получил «59131» с
//     update_id=785300455 — это апдейт из сессии 13:46 (там он был ответом на
//     раунд 5), т.е. картинка была размечена ЧУЖИМИ цифрами.
// G4. «картинка не собралась» БЕЗ ПРИЧИНЫ. Лог 19:51–19:54: три раунда по 48–52с,
//     «сеть 0.0с + сборка 0.0с», ни одного фото — и ни слова о причине в
//     telegram.log. Теперь причина (lastNote: таймаут / прокси / нет стен / мало
//     плиток) пишется в лог и приходит в чат, вместе с «ПРОКСИ МЁРТВ» и IP.
// G5. /glyphs дополнительно шлёт ASCII-превью кропов текстом — его можно
//     скопировать и показать, даже если картинка в чате ничего не объясняет.
// ====================================================================
//
// ============ ЧТО ИСПРАВЛЕНО В v3.11.1 (по вашему логу 18:48) ============
// F1. «ПРИЗРАЧНЫЙ /stop». Telegram хранит неподтверждённые апдейты: прошлая
//     сессия получила /stop (update_id=785300572), но не успела подтвердить
//     offset — и новая сессия получила его снова, завершившись на первом же
//     раунде. Теперь: (а) при старте offset выставляется ПО РЕЗУЛЬТАТУ
//     сброса старых апдейтов, (б) сообщения с date старше старта сессии
//     игнорируются и это пишется в лог («игнорирую старое сообщение»).
// F2. СТАРАЯ MLP ПОДМЕШИВАЛА БРЕД. В логе: «база цифр: 0 {} | MLP загружена»
//     и «предсказание "27857"» при пустой базе — это model.json, обученная на
//     признаках прошлой версии (fv=2). Размерность совпадала, поэтому модель
//     грузилась и выдавала уверенный мусор (0.65). Теперь в model.json пишется
//     fv, и модель чужой версии НЕ загружается + понятное предупреждение
//     в лог и в чат. Старые примеры glyphs.jsonl так же отсеиваются (fv).
// F3. [YOLO] НЕ БЫЛО ВИДНО В ЛоГЕ. yoloLog писал только в общий лог, поэтому
//     в learn/telegram.log нельзя было понять, отвечал ли API. Теперь дублируется
//     в telegram.log, а в строке раунда печатается: YOLO="..." | локально="..."
//     | ответ бота=... (источник).
// F4. Мёртвый YOLO-эндпоинт больше не тормозит раунды: после 2 отказов URL
//     пропускается до конца сессии (раньше каждый раунд ждал полный таймаут).
// ====================================================================
//
// ======================= ЧТО НОВОГО В v3.11.0 (YOLO API) =======================
// Y1. ПОДКЛЮЧЁН YOLO-API — основной распознаватель капчи FunTime.
//     Источники: github.com/mmeerrkkaa/funtime-captcha-verifed (lib/localOCR.js)
//     и тред yougame.biz/threads/368895 (YOLO12n, ~91% на FunTime).
//     Контракт: POST multipart, поле "image" (PNG) ->
//       {"success":true,"answer":"12345"}   (/recognize, публичный сервер)
//       {"result":"12345"}                  (/solve, Flask-бэк из треда)
//     Поддержаны оба формата + {text}/{digits}/{boxes:[{class}]} + голые цифры.
//     Эндпоинты по умолчанию (по порядку):
//       1) http://127.0.0.1:5000/recognize  — СВОЙ сервер (python yolo_server.py, 91%)
//       2) http://212.22.70.39:5000/recognize — публичный бесплатный (~85%)
//     Рабочий эндпоинт запоминается, при отказе — авто-fallback на следующий,
//     после 6 ошибок подряд API перестаёт дёргаться (не тормозим раунды).
//     HTML-страница вместо JSON отвергается (иначе «404» читался как цифры).
// Y2. В чате бот теперь показывает ОБА ответа: «🌐 YOLO API: 48152» и
//     «🤖 Локально: 48152», и предупреждает, если они расходятся.
//     «+» подтверждает ответ бота (YOLO, если он ответил).
//     Счётчик «10 подряд» по умолчанию считает ответ YOLO, а локальная модель
//     всё равно учится на каждом вашем ответе (telegram.streakSource: auto|yolo|local).
// Y3. yolo_server.py — готовый локальный сервер под вашу best.pt: /recognize,
//     /solve, /health, прогон с понижением conf 0.8->0.25, подавление дублей
//     по IoU, сортировка по x, --test для проверки модели без запуска сервера.
// Y4. Команды: /yolo в чате (проверка API на текущей картинке),
//     node main.js --yolo-test FILE.png (проверка из консоли).
// Y5. Жёсткие ворота на маску (фикс «88888»): сплошные/пустые рамки и
//     маска-«всё чернила» теперь ОТБРАСЫВАЮТСЯ, добавлены маски по порогу
//     яркости (развёртка 40..190) и цветовым кластерам k-means.
// Y6. Опция log.localTime=true — таймстампы в местном времени вместо UTC.
// ====================================================================
//
// ======================= ЧТО НОВОГО В v3.10.0 (СЕГМЕНТАЦИЯ ЦИФР) =======================
// D1. НОВЫЙ ПРИНЦИП ПОИСКА ЦИФР. Раньше: «фон = доминирующий цвет» -> связные
//     компоненты. На реальной капче (пёстрый/дитеринговый фон, слипшиеся цифры,
//     рассыпающиеся штрихи) это давало 0 или сотни мусорных кусков — учиться
//     было нечего. Теперь: раз цифр ЗАВЕДОМО 5, мы их не «ищем», а ПОДБИРАЕМ
//     маску и РЕЖЕМ строку ровно на 5 частей:
//       • ~50 масок-кандидатов: доминантный фон (1-3 цвета) и инверсия, Otsu по
//         яркости (тёмное/светлое), локальный фон по тайлам 64/128, КАЖДЫЙ цвет
//         палитры отдельно (цифры обычно одного цвета), + морфология open/close;
//       • на каждой маске ищем полосу строк с цифрами;
//       • полосу режет ДИНАМИЧЕСКОЕ ПРОГРАММИРОВАНИЕ ровно на 5 сегментов:
//         границы там, где меньше всего чернил, ширина близка к равномерной
//         (слипшиеся цифры разрезаются, рассыпавшиеся склеиваются);
//       • каждая нарезка оценивается (одинаковая высота/ширина, равномерность
//         промежутков, одна строка, пропорции, заполнение, контраст к фону,
//         штраф за чернила ВНЕ рамок) — побеждает лучшая стратегия.
//     Замер на 6 типах фона (ровный, слипшиеся цифры, инверсный, блочный шум,
//     пиксельный шум, «враждебный» — цвет цифр есть и в шуме): рамки цифр
//     найдены с точностью 0-1 px во ВСЕХ шести случаях.
// D2. ЗАМОК СТИЛЯ: победившая маска запоминается в learn/style.json и в следующих
//     раундах применяется сразу (если балл >= 100). Перебор 50 стратегий (156 мс)
//     превращается в одну маску (5 мс) — в 30 раз быстрее.
// D3. Нормализация глифа БЕЗ искажения пропорций (вписываем в 20×28 с центровкой,
//     раньше растягивали — тонкие цифры плющило). Версия признаков fv=2: старые
//     примеры из glyphs.jsonl игнорируются (несовместимы), база набирается заново.
// D4. Аугментация: у каждого примера в памяти 8 вариантов (сдвиги/масштаб/поворот),
//     расстояние до примера = минимум по вариантам, а голосуют по-прежнему разные
//     примеры (важно: если плодить дубли в базе, k-NN вырождается в 1-NN и точность
//     ПАДАЕТ — проверено: 76% -> 12%). Сейчас: +6..10% при том же числе ответов.
// D5. Диагностика сегментации в каждом раунде: debug_segmentation.png (картинка
//     с найденными рамками и полосой) и segmentation_report.json (все стратегии
//     с баллами). Если цифр найдено не 5 — бот говорит об этом в чат и просит /skip.
// D6. Замер обучения (синтетика, вариации масштаба/смещения/шума):
//     1 размеченная капча (5 ответов) -> 50% цифр, 2 капчи -> 80%, 4 капчи -> 99.2%.
// ====================================================================
//
// ======================= ЧТО НОВОГО В v3.9.3 (УСКОРЕНИЕ) =======================
// S1. БЫСТРЫЙ РЕЖИМ — включается сам в Telegram-сессии (или "capture":{"fast":true}).
//     По вашему логу на раунд уходило ~6.5 с, из них ~3 с — просто паузы:
//       • пауза между раундами      2000 мс -> 250 мс
//       • пауза перед попыткой    1000..2000 мс -> 150..400 мс
//       • ожидание «тишины» потока   1500 мс -> 600 мс
//       • добор после «готово»        800 мс -> 200 мс
// S2. Готовность по ФАКТУ ДАННЫХ: если все плитки стены получили полные
//     16384 байта (128×128) — ждать «тишину» не нужно, забираем сразу.
// S3. Облегчённая запись в быстром режиме: не пишем variants/, tiles/*.bin,
//     ORIGINAL_CAPTCHA_mask.png и legacy-OCR (экономит ~170 мс на раунд:
//     замер 224 мс -> 55 мс). Всё нужное остаётся: обе PNG, raw.bin,
//     layout/assembly_debug/walls_debug/digits.json, glyphs/, логи.
//     Полный набор файлов по-прежнему пишется в обычном режиме и в --replay.
// S4. Предзагрузка по умолчанию 2 -> 3 картинки: пока вы отвечаете,
//     в очереди уже лежат три следующих. В логе видно тайминги каждого раунда:
//     «раунд 5 подготовлен за 2.1с (сеть 1.6с + сборка 0.1с) | в очереди 3/3».
//     Итого ~2 с на раунд вместо ~6.5 с, и пауз между картинками нет вовсе.
// ====================================================================
//
// ======================= ЧТО НОВОГО В v3.9.2 =======================
// T1. В КАПЧЕ ВСЕГДА РОВНО 5 ЦИФР (digits.expected=5). Вырезание глифов
//     выбирает строку, где цифр ровно 5; лишнее (шум) отсеивается по
//     «цифроподобности»; если нашлось не 5 — в лог и в чат идёт предупреждение.
// T2. Вместе с фото бот ВСЕГДА присылает своё ПРЕДСКАЗАНИЕ (5 символов,
//     неуверенные позиции помечаются) + среднюю уверенность + счётчик «N/10 подряд».
// T3. Ответ человека = ИСТИНА: его цифры всегда идут в обучающую базу.
//     Сессия идёт, пока предсказание бота не совпадёт с ответом 10 раз ПОДРЯД
//     (telegram.targetStreak), после чего бот присылает 🎓 и останавливается.
//     Раунды больше не ограничены десятком — лимит telegram.maxRounds (500).
// T4. Предсказание ПЕРЕСЧИТЫВАЕТСЯ свежей базой в момент отправки: картинка
//     готовится заранее (конвейер), а база к этому времени уже подросла.
// T5. [ФИКС] Deadlock в очереди конвейера: shift() не будил ожидающий push() —
//     после 3-й картинки всё вставало. Плюс потребитель теперь всегда закрывает
//     очередь (иначе производитель вечно ждал места).
// T6. [ФИКС] getUpdates: Telegram присылает несколько апдейтов пачкой, offset
//     подтверждает их все — непрочитанные теперь буферизуются локально,
//     иначе второе сообщение терялось и бот зависал.
// T7. Прокси Telegram: читаются ключи apiProxy/socksUrl/proxy/socks (в вашем
//     конфиге — telegram.apiProxy), поддержан socks5h://, спец-прокси пробуется
//     ПЕРВЫМ, мобильный прокси MC — только как последний резерв.
//     Диагностика: node main.js --tg-test
// ====================================================================
//
// ======================= ЧТО БЫЛО НОВОГО В v3.9.1 =======================
// A-1. [v3.9.1] TELEGRAM-БОТ РАЗМЕТКИ: main.js сам (без npm-пакетов, чистый
//      https + SOCKS-файлбэк) шлёт картинку капчи в ваш чат, вы отвечаете
//      цифрами — глифы сразу уходят в обучающую базу. Следующая картинка
//      готовится ЗАРАНЕЕ (конвейер, telegram.prefetch=2), поэтому разметка
//      идёт без пауз. Команды: «+» (подтвердить догадку), /skip, /glyphs,
//      /status, /train, /stop, /help. Лог: learn/telegram.log.
//      Если telegram.token/chat_id не заданы — работает как раньше (сбор картинок).
// A0. [v3.9.1] Распознаватель цифр и инструмент разметки ВСТРОЕНЫ в этот файл:
//     больше не бывает «digits.js не загружен». Один файл = всё работает.
//     label.js/digits.js остались тонкими обёртками (не обязательны).
// A1. [v3.9.1] Скоринг стены: дистанция — главный признак (±2200), yaw (dot)
//     вспомогательный (±500). В вашем логе правильная стена была в 2.4-3.7 блока,
//     но в 5 раундах стояла ЗА спиной бота (dot=-0.98) и выигрывала впритык.
// A2. [v3.9.1] seam-штраф не может стать бонусом; порог предупреждения 40
//     (по вашему прогону seam правильной стены = 6..24).
// A. [ФИКС РАУНДА 6] Roboflow УДАЛЁН полностью (403/405, ключ не тот — «яма»).
//    Распознавание теперь локальное и самообучающееся: digits.js + label.js.
// B. [ФИКС РАУНДА 6] Выбран правильный детектор стены. На сервере две
//    параллельные стены капчи, поэтому рамки обеих стен с одинаковым x
//    образовывали «сквозную» псевдоплоскость (x4/x5/x6 по 6 рамок) с рваной
//    сеткой — именно её v3.8.0 и выбрал в раунде 6 (seam=90 вместо 10-18).
//    Теперь такие кандидаты отбрасываются по двум признакам:
//      • промежуток между соседними колонками/строками сетки > 2.5 блока;
//      • разброс yaw рамок в плоскости > 2.2 рад (рамки смотрят в разные стороны).
//    Плюс полностью пересобран скоринг стены: геометрия (seam, размер, доля
//    заполнения, куда смотрит бот и как далеко стена) важнее распознавания.
//    Локальный OCR больше не может «перетянуть» мусорную стену на себя.
// C. ЦИФРЫ: glyphs → нормализация 20×28 → k-NN по размеченной базе (+ MLP
//    после --train). Неуверенные глифы уходят в очередь learn/queue.jsonl,
//    разметка — node main.js --label (ASCII-арт в терминале, клавиша 0..9).
//    Каждый размеченный глиф сразу улучшает следующий раунд.
// D. Каждый раунд пишет walls_debug.json с разбором ВСЕХ кандидатов и их
//    скорингом — если выбор опять окажется неверным, по нему сразу видно почему.
// E. Раунд стал заметно быстрее: убраны 4-16 HTTP-запросов к Roboflow
//    (~22 с на раунд по вашему логу).
//
// Запуск:
//   node main.js                 # 10 раундов: картинки + цифры
//   node main.js --proxy-check   # диагностика прокси/IP (DNS, SOCKS5, HTTP-резерв, смена IP, пинг MC) + вердикт
//   node main.js --label         # разметка глифов (обучение)  [или node main.js --label]
//   node main.js --train         # обучить MLP по размеченной базе
//   node main.js --autotune [--apply]  # офлайн-подбор маски сегментации по сохранённым картинкам
//   node main.js --diag [DIR]    # диагностика одной картинки (топ стратегий, ASCII-кропы, фото с рамками)
//   node main.js --import-answers learn\telegram.log  # импорт старых ответов человека
//   node main.js --selftest      # 72 проверки без сервера
//   node main.js --replay DIR    # пересобрать картинку из старой записи
//   node main.js --rounds 3      # короткий прогон
//   node main.js --debug         # подробный лог
// ====================================================================

'use strict'

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const http = require('http')
const https = require('https')
const tls = require('tls')
const net = require('net')     // свой SOCKS5-клиент: диагностика прокси и резервный хост
const dns = require('dns')

// mineflayer/socks нужны только для живого забега. Для --selftest/--replay — не нужны.
let mineflayer = null
try { mineflayer = require('mineflayer') } catch (e) { /* опционально */ }
// распознаватель цифр определён ниже (встроен в файл)
let SocksClient = null
try { SocksClient = require('socks').SocksClient } catch (e) { /* опционально */ }

// ========================= CLI =========================
const ARGV = process.argv.slice(2)
function argVal(name, dflt) {
  const i = ARGV.indexOf('--' + name)
  if (i < 0) return dflt
  const v = ARGV[i + 1]
  return (v === undefined || v.startsWith('--')) ? true : v
}
const CLI = {
  selftest: ARGV.includes('--selftest'),
  rounds: Number(argVal('rounds', 0)) || 0,
  replay: typeof argVal('replay', '') === 'string' ? argVal('replay', '') : '',
  replayAll: typeof argVal('replay-all', '') === 'string' ? argVal('replay-all', '') : '',
  train: ARGV.includes('--train'),
  tgTest: ARGV.includes('--tg-test'),
  yoloTest: typeof argVal('yolo-test', '') === 'string' ? argVal('yolo-test', '') : '',
  perms: ARGV.includes('--perms'),
  label: ARGV.includes('--label'),
  debug: ARGV.includes('--debug'),
  // офлайн-настройка сегментации по уже сохранённым картинкам и ответам человека.
  // ВАЖНО: argVal возвращает '' когда флага нет, поэтому «typeof === 'string'»
  // всегда true — признак берём ТОЛЬКО из ARGV.includes, а значение отдельно.
  autotune: ARGV.includes('--autotune'),
  autotuneDir: (typeof argVal('autotune', '') === 'string' && argVal('autotune', '') !== '') ? argVal('autotune', '') : '',
  importAnswers: ARGV.includes('--import-answers')
    ? ((typeof argVal('import-answers', '') === 'string' && argVal('import-answers', '') !== '') ? argVal('import-answers', '') : path.join('learn', 'telegram.log'))
    : '',
  apply: ARGV.includes('--apply'),
  proxyCheck: ARGV.includes('--proxy-check') || ARGV.includes('--proxy'),
  diag: ARGV.includes('--diag'),
  diagDir: (typeof argVal('diag', '') === 'string' && argVal('diag', '') !== '') ? argVal('diag', '') : ''
}

// ========================= КОНСТАНТЫ ЗАБЕГА =========================
const TARGET_ROUNDS = CLI.rounds > 0 ? CLI.rounds : 10
const ATTEMPTS_PER_ROUND = 2
const PAUSE_BETWEEN_MS = 2000
const SETTLE_MS = 800             // добор данных после "готово"

const STABLE_MS = 1500            // поток map_data должен затихнуть на это время
const CAPTCHA_TIMEOUT_MS = 75000  // жёсткий лимит на подключение+сбор
const CONNECT_TIMEOUT_MS = 35000
const LOGIN_TIMEOUT_MS = 30000
const MAX_ROTATIONS_ON_FAIL = 6
const MIN_TILES_DEFAULT = 6       // минимум плиток, чтобы считать раунд успешным
const MIN_TILES_FRACTION = 0.6    // или 60% от размера сетки
const VIEW_SIGN = 1

// каталог обучающей базы цифр (можно переопределить переменной окружения LEARN_DIR)
let LEARN_DIR = process.env.LEARN_DIR ? path.resolve(process.env.LEARN_DIR) : path.join(__dirname, 'learn')

// ========================= ГЛОБАЛЬНЫЕ =========================
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const SLOG = []
let REC_ROOT = null
let CAP_ROOT = null

function logStamp() {
  if (!LOG_LOCAL_TIME) return new Date().toISOString().slice(11, 19)
  const d = new Date()
  const p = n => String(n).padStart(2, '0')
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
}
function step(s) {
  const l = logStamp() + ' [step] ' + s
  SLOG.push(l)
  console.log(l)
}
function dbg(s) { if (CLI.debug) step('[dbg] ' + s) }

function flushReport(extra) {
  if (!REC_ROOT) return
  try {
    fs.writeFileSync(path.join(REC_ROOT, 'report_' + STAMP + '.txt'), SLOG.join('\n') + '\n' + (extra || ''))
  } catch (e) { console.error('flushReport err:', e.message) }
}

process.on('uncaughtException', e => {
  console.error('\n!!! UNCAUGHT EXCEPTION !!!\nMessage:', e.message, '\nStack:', e.stack)
  flushReport('UNCAUGHT: ' + (e.stack || e.message))
  setTimeout(() => process.exit(1), 1000)
})
process.on('unhandledRejection', e => {
  console.error('\n!!! UNHANDLED REJECTION !!!\nError:', e)
  flushReport('REJECTION: ' + (e && e.message ? e.message : String(e)))
})

// ========================= КОНФИГ =========================
let CFG_PARENT, CFG_LOCAL, CFG_PATH, CFG = {}, CFG_STRATEGY = 'none'

try {
  CFG_PARENT = path.join(__dirname, '..', 'config.json')
  CFG_LOCAL = path.join(__dirname, 'config.json')
  CFG_PATH = fs.existsSync(CFG_LOCAL) ? CFG_LOCAL : (fs.existsSync(CFG_PARENT) ? CFG_PARENT : null)
} catch (e) { console.error('CFG_PATH error:', e.message) }

function cfgGet(o, kp, d) {
  let c = o
  for (const k of kp.split('.')) { if (!c || c[k] === undefined) return d; c = c[k] }
  return c
}
function isEmptyCfgVal(v) { return v === undefined || v === null || v === '' || (typeof v === 'number' && Number.isNaN(v)) }
function softCleanJson(t) {
  let s = String(t || '').replace(/^\uFEFF/, '')
  s = s.replace(/:\s*""(?=[^",\s\]}])/g, ': "')
  s = s.replace(/,\s*([}\]])/g, '$1')
  s = s.replace(/(^|[^:"'\\])\/\/[^\n\r]*/g, '$1')
  return s
}
function extractJsonObject(t) {
  const s = String(t || ''); const i = s.indexOf('{'); const j = s.lastIndexOf('}')
  return (i >= 0 && j > i) ? s.slice(i, j + 1) : ''
}
function parseCfgRaw(raw) {
  const candidates = [String(raw || ''), softCleanJson(raw), extractJsonObject(raw), softCleanJson(extractJsonObject(raw))]
  for (const c of candidates) {
    if (!c) continue
    try { const o = JSON.parse(c); if (o && typeof o === 'object' && !Array.isArray(o)) return o } catch (e) {}
  }
  return null
}
function sectionBody(raw, name) {
  const s = String(raw || '')
  const km = s.match(new RegExp('"' + name + '"\\s*:\\s*\\{'))
  if (!km) return ''
  const start = km.index + km[0].length - 1
  let depth = 0, inStr = false, esc = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (esc) { esc = false; continue }
    if (ch === '\\') { esc = true; continue }
    if (ch === '"') { inStr = !inStr; continue }
    if (inStr) continue
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) return s.slice(start, i + 1) }
  }
  return ''
}
function grabIn(b, k) { const m = String(b || '').match(new RegExp('"' + k + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"')); return m ? m[1] : undefined }
function grabNumIn(b, k) { const m = String(b || '').match(new RegExp('"' + k + '"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)')); return m ? Number(m[1]) : undefined }
function regexCfg(raw) {
  const cfg = {}
  const put = (sec, key, val) => { if (isEmptyCfgVal(val)) return; if (!cfg[sec]) cfg[sec] = {}; cfg[sec][key] = val }
  const mc = sectionBody(raw, 'minecraft')
  if (mc) { put('minecraft', 'server', grabIn(mc, 'server')); put('minecraft', 'port', grabNumIn(mc, 'port')); put('minecraft', 'version', grabIn(mc, 'version')) }
  const px = sectionBody(raw, 'proxy')
  if (px) {
    put('proxy', 'host', grabIn(px, 'host')); put('proxy', 'port', grabNumIn(px, 'port'))
    put('proxy', 'username', grabIn(px, 'username')); put('proxy', 'password', grabIn(px, 'password'))
    put('proxy', 'changeIpUrl', grabIn(px, 'changeIpUrl')); put('proxy', 'waitAfterIpChangeSec', grabNumIn(px, 'waitAfterIpChangeSec'))
  }
  const ac = sectionBody(raw, 'accounts')
  if (ac) { put('accounts', 'nickPrefix', grabIn(ac, 'nickPrefix')) }
  const rf = sectionBody(raw, 'roboflow')
  if (rf) { put('roboflow', 'enabled', /"enabled"\s*:\s*true/.test(rf)); put('roboflow', 'apiKey', grabIn(rf, 'apiKey')); put('roboflow', 'modelId', grabIn(rf, 'modelId')) }
  return cfg
}
try {
  if (CFG_PATH) {
    let raw = ''
    try { raw = fs.readFileSync(CFG_PATH, 'utf8').replace(/^\uFEFF/, '') } catch (e) { raw = '' }
    const parsed = parseCfgRaw(raw)
    const fb = regexCfg(raw)
    if (parsed) { CFG = parsed; CFG_STRATEGY = 'json' }
    else if (Object.keys(fb).length) { CFG = fb; CFG_STRATEGY = 'regex-fallback' }
  }
} catch (e) { console.error('CFG parse error:', e.message) }

const MC = {
  host: cfgGet(CFG, 'minecraft.server', 'connect.funtime.su'),
  port: cfgGet(CFG, 'minecraft.port', 25565),
  version: cfgGet(CFG, 'minecraft.version', '1.21.1')
}
const PROXY = {
  host: cfgGet(CFG, 'proxy.host', ''),
  port: cfgGet(CFG, 'proxy.port', 1080),
  username: cfgGet(CFG, 'proxy.username', ''),
  password: cfgGet(CFG, 'proxy.password', ''),
  changeIpUrl: cfgGet(CFG, 'proxy.changeIpUrl', ''),
  waitSec: cfgGet(CFG, 'proxy.waitAfterIpChangeSec', 12)
}
const NICK_PREFIX = String(cfgGet(CFG, 'accounts.nickPrefix', 'Player')).replace(/[^a-zA-Z0-9]/g, '').slice(0, 10) || 'Player'

// ========================= YOLO API (распознавание капчи FunTime) =========================
// Источники: github.com/mmeerrkkaa/funtime-captcha-verifed (lib/localOCR.js) и
// тред yougame.biz/threads/368895 (YOLO12n, ~91% на FunTime).
// Контракт: POST multipart/form-data, поле "image" (PNG) ->
//   { "success": true, "answer": "12345" }   (публичный сервер /recognize)
//   { "result": "12345" }                    (Flask-бэк из треда, /solve)
// Публичный бесплатный сервер: http://212.22.70.39:5000/recognize (~85%)
// Своя модель (91%): python yolo_server.py -> http://localhost:5000/recognize
const YOLO_DEFAULT_URLS = [
  'http://127.0.0.1:5000/recognize',       // свой локальный сервер (если запущен)
  'http://212.22.70.39:5000/recognize'     // публичный бесплатный (из README плагина)
]
function yoloUrls() {
  const out = []
  const one = String(cfgGet(CFG, 'yolo.url', '') || '').trim()
  if (one && /^https?:\/\//i.test(one)) out.push(one)
  const list = cfgGet(CFG, 'yolo.urls', null)
  if (Array.isArray(list)) for (const u of list) if (typeof u === 'string' && /^https?:\/\//i.test(u)) out.push(u.trim())
  for (const u of YOLO_DEFAULT_URLS) if (out.indexOf(u) < 0) out.push(u)
  return out
}
const YOLO = {
  enabled: cfgGet(CFG, 'yolo.enabled', true) !== false,
  urls: yoloUrls(),
  field: String(cfgGet(CFG, 'yolo.field', 'image') || 'image'),
  timeoutMs: Math.max(2000, Number(cfgGet(CFG, 'yolo.timeoutMs', 9000)) || 9000),
  autoLabel: cfgGet(CFG, 'yolo.autoLabel', false) === true,
  // сколько цифр ждём от API: из config, иначе DIGITS_EXPECTED (5 для funtime)
  digitsCfg: Number(cfgGet(CFG, 'yolo.digits', 0)) || 0
}
const yoloWantDigits = () => YOLO.digitsCfg || DIGITS_EXPECTED || 5
let yoloAlive = null      // запомненный рабочий url
let yoloFails = 0
const yoloUrlFails = {}   // сколько раз каждый url не ответил (чтобы не ждать таймаут заново)
const YOLO_MAX_FAILS = 6  // после серии ошибок перестаём дёргать API (экономим время раунда)

function yoloLog(m) {
  step('[YOLO] ' + m)
  // дублируем в telegram.log — иначе в логе сессии не видно, отвечал ли API
  try { fs.mkdirSync(LEARN_DIR, { recursive: true }); fs.appendFileSync(tgLogFile(), logStamp() + ' [YOLO] ' + m + '\n') } catch (e) {}
}
// сброс запомненного рабочего эндпоинта и счётчика ошибок (для тестов и команды /yolo)
function yoloReset() { yoloAlive = null; yoloFails = 0; for (const k of Object.keys(yoloUrlFails)) delete yoloUrlFails[k] }

function multipart(fields, file) {
  const b = '----mc' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
  const parts = []
  for (const k of Object.keys(fields || {})) {
    if (fields[k] === undefined || fields[k] === null) continue
    parts.push(Buffer.from('--' + b + '\r\nContent-Disposition: form-data; name="' + k + '"\r\n\r\n' + String(fields[k]) + '\r\n'))
  }
  if (file) {
    parts.push(Buffer.from('--' + b + '\r\nContent-Disposition: form-data; name="' + file.field + '"; filename="' + file.name + '"\r\nContent-Type: ' + (file.type || 'application/octet-stream') + '\r\n\r\n'))
    parts.push(Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data))
    parts.push(Buffer.from('\r\n'))
  }
  parts.push(Buffer.from('--' + b + '--\r\n'))
  return { body: Buffer.concat(parts), contentType: 'multipart/form-data; boundary=' + b }
}

// разбор ответа: поддерживаем все известные формы
function parseYoloAnswer(text) {
  const s = String(text || '')
  if (/^\s*</.test(s) || /<\/?html|<body|<!doctype/i.test(s.slice(0, 500))) return { digits: '', rejected: true, raw: 'HTML вместо JSON: ' + s.slice(0, 120) }
  let j = null
  try { j = JSON.parse(s) } catch (e) {}
  let raw = ''
  if (j && typeof j === 'object') {
    if (j.success === false) return { digits: '', rejected: true, raw: s.slice(0, 200) }
    const d = j.data && typeof j.data === 'object' ? j.data : {}
    const cand = [j.answer, j.result, j.text, j.digits, j.captcha, j.code, d.answer, d.result, d.text, d.digits]
    for (const c of cand) if (c !== undefined && c !== null && String(c).trim()) { raw = String(c); break }
    if (!raw && Array.isArray(j.boxes)) raw = j.boxes.map(b => b && (b.class !== undefined ? b.class : b.label)).join('')
  }
  if (!raw) raw = s
  return { digits: raw.replace(/[^0-9]/g, ''), rejected: false, raw: s.slice(0, 200) }
}

async function yoloRecognize(png, label) {
  if (!YOLO.enabled || !png || !png.length) return null
  if (yoloFails >= YOLO_MAX_FAILS) {
    if (yoloFails === YOLO_MAX_FAILS) { yoloLog('⚠️ ' + YOLO_MAX_FAILS + ' ошибок подряд — API больше не дёргаю в этой сессии (локальная модель продолжит)'); yoloFails++ }
    return null
  }
  const order = yoloAlive ? [yoloAlive].concat(YOLO.urls.filter(u => u !== yoloAlive)) : YOLO.urls
  // имя поля: сначала из конфига, потом запасной вариант (image <-> file)
  const fields = [YOLO.field, YOLO.field === 'file' ? 'image' : 'file']
  for (const url of order) {
    if ((yoloUrlFails[url] || 0) >= 2) { dbg('[YOLO] пропускаю ' + url + ' (2 отказа подряд в этой сессии)'); continue }
    let urlFailed = false
    for (const field of fields) {
      const mp = multipart({}, { field, name: 'captcha.png', type: 'image/png', data: png })
      let u
      try { u = new URL(url) } catch (e) { continue }
      const t0 = Date.now()
      const r = await httpsRequest({
        host: u.hostname, port: Number(u.port || (u.protocol === 'http:' ? 80 : 443)),
        path: (u.pathname || '/') + (u.search || ''), method: 'POST',
        headers: { 'Content-Type': mp.contentType, 'Accept': 'application/json', 'User-Agent': 'mc-captcha/3.11' },
        body: mp.body, timeoutMs: YOLO.timeoutMs, secure: u.protocol !== 'http:'
      })
      const ms = Date.now() - t0
      if (!r.ok) { yoloLog((label || '') + ' ' + u.host + ' [' + field + ']: ' + r.error + ' (' + ms + 'мс)'); urlFailed = true; continue }
      const parsed = parseYoloAnswer(r.body ? r.body.toString('utf8') : '')
      if (parsed.digits && parsed.digits.length >= 3) {
        yoloAlive = url
        yoloFails = 0
        yoloUrlFails[url] = 0
        const want = yoloWantDigits()
        const exact = parsed.digits.length === want
        yoloLog((label || '') + ' ✅ ' + u.host + ' [' + field + '] -> "' + parsed.digits + '"' + (exact ? '' : ' ⚠️ длина ' + parsed.digits.length + ' вместо ' + want) + ' за ' + ms + 'мс')
        return { digits: parsed.digits, exact, url, host: u.host, field, ms, status: r.status }
      }
      yoloLog((label || '') + ' ' + u.host + ' [' + field + ']: HTTP ' + r.status + ', ответ без цифр: ' + parsed.raw.slice(0, 120))
      urlFailed = true
    }
    if (urlFailed) yoloUrlFails[url] = (yoloUrlFails[url] || 0) + 1
  }
  yoloFails++
  yoloLog((label || '') + ' ❌ ни один YOLO-эндпоинт не ответил (ошибок подряд: ' + yoloFails + ') — работаем локальной моделью')
  return null
}

// ========================= TELEGRAM (бот-разметчик) =========================
// Прокси для Telegram берём из любого из ключей: socksUrl / apiProxy / proxy / socks5.
// (в вашем конфиге он лежит в telegram.apiProxy)
function tgProxyFromConfig() {
  const keys = ['telegram.socksUrl', 'telegram.apiProxy', 'telegram.proxy', 'telegram.socks', 'telegram.socks5']
  for (const k of keys) {
    const v = String(cfgGet(CFG, k, '') || '').trim()
    if (v && !/YOUR_|CHANGE/i.test(v)) return { key: k, url: v }
  }
  return null
}
const TG_PROXY_CFG = tgProxyFromConfig()

const TG = {
  enabled: cfgGet(CFG, 'telegram.enabled', true) !== false,
  token: String(cfgGet(CFG, 'telegram.token', '') || '').trim(),
  chatId: String(cfgGet(CFG, 'telegram.chatId', '') || '').trim(),
  apiUrl: String(cfgGet(CFG, 'telegram.apiUrl', 'https://api.telegram.org') || 'https://api.telegram.org').replace(/\/+$/, ''),
  socksUrl: TG_PROXY_CFG ? TG_PROXY_CFG.url : '',
  socksKey: TG_PROXY_CFG ? TG_PROXY_CFG.key : '',
  // специальный прокси пробуем ПЕРВЫМ: прямой доступ к api.telegram.org в РФ обычно таймаутит
  preferSocks: cfgGet(CFG, 'telegram.preferSocks', true) !== false,
  // мобильный прокси Minecraft — только как последний резерв (он часто режет не-MC трафик
  // и ротация IP рвёт long polling)
  useMcProxy: cfgGet(CFG, 'telegram.useMcProxy', true) !== false,
  prefetch: Math.max(1, Number(cfgGet(CFG, 'telegram.prefetch', 3)) || 3),
  timeoutMs: Math.max(10000, Number(cfgGet(CFG, 'telegram.timeoutMs', 30000)) || 30000),
  probeTimeoutMs: Math.max(4000, Number(cfgGet(CFG, 'telegram.probeTimeoutMs', 12000)) || 12000),
  autoTrainEvery: Math.max(0, Number(cfgGet(CFG, 'telegram.autoTrainEvery', 20)) || 0),
  // сессия обучения идёт, пока ответы бота и человека не совпадут N раз ПОДРЯД
  targetStreak: Math.max(1, Number(cfgGet(CFG, 'telegram.targetStreak', 10)) || 10),
  // чей ответ сравнивать с вашим: 'auto' = YOLO если ответил, иначе локальная модель
  streakSource: String(cfgGet(CFG, 'telegram.streakSource', 'auto') || 'auto'),
  maxRounds: Math.max(1, Number(cfgGet(CFG, 'telegram.maxRounds', 500)) || 500),
  sendGlyphStrip: cfgGet(CFG, 'telegram.sendGlyphStrip', false) === true
}
TG.ready = !!(TG.enabled && TG.token && !/YOUR_|^$/.test(TG.token) && TG.chatId && !/YOUR_/.test(TG.chatId))

const GLYPH_OPTS = {
  minH: Number(cfgGet(CFG, 'digits.minGlyphH', 0)) || null,
  maxH: Number(cfgGet(CFG, 'digits.maxGlyphH', 0)) || null,
  minW: Number(cfgGet(CFG, 'digits.minGlyphW', 0)) || null,
  maxW: Number(cfgGet(CFG, 'digits.maxGlyphW', 0)) || null,
  digitRatio: Number(cfgGet(CFG, 'digits.digitRatio', 0.62)) || 0.62,
  maxParts: Number(cfgGet(CFG, 'digits.maxParts', 5)) || 5
}
const DIG_CONF_OK = Number(cfgGet(CFG, 'digits.confOk', 0.62)) || 0.62
// СКОЛЬКО ЦИФР В КАПЧЕ. На funtime всегда ровно 5 — ни больше, ни меньше.
const DIGITS_EXPECTED = Math.max(0, Number(cfgGet(CFG, 'digits.expected', 5)) || 0)
// минимальный балл умной сегментации; ниже — откат к старому методу (связные компоненты)
const SEG_MIN_SCORE = Number(cfgGet(CFG, 'digits.segMinScore', 60)) || 60
// аугментация: у каждого примера в памяти хранятся сдвиги/масштабы/повороты,
// расстояние до примера = минимум по вариантам. Даёт +6..10% точности при том же
// числе ответов человека (замер: 88.8% -> 94.4% по цифрам после 4 размеченных капч).
const DIG_AUGMENT = cfgGet(CFG, 'digits.augment', true) !== false
// «замок стиля»: рабочая маска запоминается в learn/style.json и в следующих раундах
// применяется сразу (экономит перебор ~50 стратегий)
const STYLE_LOCK_MIN = Number(cfgGet(CFG, 'digits.styleLockMin', 100)) || 100
// log.localTime=true — таймстампы в местном времени вместо UTC (по умолчанию UTC)
const LOG_LOCAL_TIME = cfgGet(CFG, 'log.localTime', false) === true

// перестановка колонок — аварийный режим (по умолчанию координаты авторитетны)
const TRY_COL_PERMS = CLI.perms === true || cfgGet(CFG, 'capture.tryColPerms', false) === true
// порог «швы плохие» — повод предупредить о возможной неверной раскладке
const SEAM_WARN = Number(cfgGet(CFG, 'capture.seamWarn', 40)) || 40

const CAP = {
  minTiles: Number(cfgGet(CFG, 'capture.minTiles', MIN_TILES_DEFAULT)) || MIN_TILES_DEFAULT,
  stableMs: Number(cfgGet(CFG, 'capture.stableMs', STABLE_MS)) || STABLE_MS,
  timeoutMs: Number(cfgGet(CFG, 'capture.timeoutMs', CAPTCHA_TIMEOUT_MS)) || CAPTCHA_TIMEOUT_MS,
  needPrompt: cfgGet(CFG, 'capture.needPrompt', false) === true
}

// ========================= БЫСТРЫЙ РЕЖИМ (для Telegram-обучения) =========================
// В обычном режиме между раундами стоят паузы «для вежливости» к серверу (~3 с на раунд).
// В режиме обучения это чистая потеря времени: картинки и так готовятся вперёд.
// Включается сам в Telegram-сессии; вручную: "capture": { "fast": true } / выкл: false.
const FAST = {
  pauseBetween: 250,      // было 2000
  preSleepMin: 150,       // было 1000
  preSleepRnd: 250,       // было +random(1000)
  stableMs: 600,          // было 1500 (ожидание «тишины» в потоке данных)
  settleMs: 200,          // было 800  (добор после «готово»)
  lightFiles: true        // не писать variants/, tiles/*.bin, DECOY_*.png, маску — экономит ~0.3 с
}
const FAST_CFG = cfgGet(CFG, 'capture.fast', 'auto')
let FAST_MODE = FAST_CFG === true

try {
  REC_ROOT = path.join(__dirname, 'records')
  CAP_ROOT = path.join(REC_ROOT, 'captchas')
  fs.mkdirSync(CAP_ROOT, { recursive: true })
} catch (e) { console.error('REC_ROOT error:', e.message) }

const sleep = ms => new Promise(r => setTimeout(r, ms))

const NET_FAIL_RE = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|socket hang up|socks|login timeout|spawn timeout/i
const PROXY_DEAD_RE = /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ECONNABORTED/i
// ошибки окружения: повторять попытки бессмысленно
const FATAL_RE = /не установлен|нет proxy\.host|модуль socks/i
const badIPs = new Set()
let currentRunIp = null

// ========================= HTTP / IP =========================
function plainGet(urlStr, timeoutMs) {
  timeoutMs = timeoutMs || 15000
  const buildList = u => { u = String(u || ''); return u.startsWith('https:') ? [u, u.replace('https:', 'http:')] : [u, u.replace('http:', 'https:')] }
  return new Promise((resolve, reject) => {
    let stopped = false, lastErr = 'get failed'
    const attempt = (urls, idx, redirectsLeft, insecure) => {
      if (stopped) return
      if (idx >= urls.length) { stopped = true; reject(new Error(lastErr)); return }
      const u = urls[idx]
      const mod = String(u).startsWith('https') ? https : http
      const opts = { timeout: timeoutMs, headers: { 'User-Agent': 'Mozilla/5.0 MC_Bot/3.8.0', 'Accept': '*/*' } }
      if (insecure) opts.rejectUnauthorized = false
      let req = null
      const timer = setTimeout(() => {
        if (stopped) return
        try { if (req) req.destroy() } catch (e) {}
        lastErr = 'timeout'; attempt(urls, idx + 1, redirectsLeft, insecure)
      }, timeoutMs)
      try {
        req = mod.get(u, opts, res => {
          if (stopped) { try { res.resume() } catch (e) {} return }
          clearTimeout(timer)
          const sc = res.statusCode
          if (sc >= 300 && sc < 400 && res.headers.location && redirectsLeft > 0) {
            let next = String(res.headers.location)
            try { next = new URL(next, u).toString() } catch (e) {}
            try { res.resume() } catch (e) {}
            attempt(buildList(next), 0, redirectsLeft - 1, insecure); return
          }
          let d = ''
          try { res.setEncoding('utf8') } catch (e) {}
          res.on('data', c => { d += c; if (d.length > 200000) d = d.slice(-100000) })
          res.on('end', () => { if (stopped) return; stopped = true; resolve({ status: sc, body: d.trim() }) })
          res.on('error', () => { if (!stopped) attempt(urls, idx + 1, redirectsLeft, insecure) })
        })
      } catch (e) { clearTimeout(timer); attempt(urls, idx + 1, redirectsLeft, insecure); return }
      req.on('error', e => {
        if (stopped) return
        clearTimeout(timer)
        if (!insecure && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO|HANDSHAKE|SSL|TLS/i.test((e && e.message) || '')) { attempt(urls, idx, redirectsLeft, true); return }
        attempt(urls, idx + 1, redirectsLeft, insecure)
      })
    }
    attempt(buildList(urlStr), 0, 3, false)
  })
}

// IP через прокси (оставлено для совместимости; основной путь — currentIp())
async function socksHttpGet(host, reqText) {
  if (!PROXY.host) return null
  try { return await socksHttpGet2(host, reqText, { timeoutMs: 10000 }) } catch (e) { return null }
}

// ========================= ПРОКСИ: свой SOCKS5, резервные хосты, диагностика =========================
// v3.13.0. Повод — лог 21:19:
//   [r1a1] socks fail: Socks5 proxy rejected connection - ConnectionRefused
//   IP до ротации: ?            <- IP не определялся, потому что он спрашивался ЧЕРЕЗ тот же мёртвый прокси
//   changeIp: direct:200 body=<!DOCTYPE html> ...   <- ссылка смены IP вернула HTML-страницу, не JSON
// Вывод: мобильный прокси MobileProxy.Space (bproxy.site:23750) не принимал TCP-соединения —
// аренда истекла / порт выключен /Equipment выключено. Код при этом продолжал «крутить IP»
// и молча показывать «?». Теперь:
//   1) свой SOCKS5-клиент (не зависит от модуля socks) — умеет и handshake, и понятные ошибки;
//   2) резервные хосты: у MobileProxy.Space тот же порт слушают bproxy.site (SOCKS5) и
//      mproxy.site (HTTP), плюс IP из DNS — пробуем всё по очереди и запоминаем живой;
//   3) currentIp() умеет работать НАПРЯМУЮ, когда прокси мёртв (иначе везде «?»);
//   4) ссылка смены IP запрашивается с format=json и браузерным User-Agent, ответ
//      разбирается: {"status":"OK","new_ip":...,"rt":...} / «30 seconds» / HTML;
//   5) node main.js --proxy-check — полная диагностика с подсказками.

function isIpV4(s) { return /^\d{1,3}(\.\d{1,3}){3}$/.test(String(s || '').trim()) }

// bproxy.site <-> mproxy.site (http-хост того же порта у MobileProxy.Space)
function altHostOf(host) {
  const h = String(host || '').toLowerCase()
  if (h.startsWith('bproxy.')) return 'mproxy.' + h.slice(7)
  if (h.startsWith('mproxy.')) return 'bproxy.' + h.slice(7)
  return null
}
// список хостов-кандидатов для одного порта: рабочий раньше -> из конфига -> запасной
function proxyHostCandidates(host) {
  const out = []
  const push = h => { h = String(h || '').trim().toLowerCase(); if (h && out.indexOf(h) < 0) out.push(h) }
  push(PROXY_OK_HOST)
  push(host || PROXY.host)
  push(altHostOf(host || PROXY.host))
  return out
}

function readExact(sock, n, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0), to = null
    const onData = d => {
      buf = Buffer.concat([buf, d])
      if (buf.length >= n) {
        const extra = buf.slice(n)
        cleanup()
        // ВАЖНО: возвращаем «лишние» байты в сокет, иначе следующий слушатель
        // (mineflayer после CONNECT) потеряет начало данных сервера, если они
        // пришли одним TCP-сегментом с SOCKS-ответом.
        if (extra.length) { try { sock.unshift(extra) } catch (e) {} }
        resolve(buf.slice(0, n))
      }
    }
    const onErr = e => { cleanup(); reject(new Error((label || 'read') + ': ' + e.message)) }
    const onEnd = () => { cleanup(); reject(new Error((label || 'read') + ': соединение закрыто (недополучено ' + (n - buf.length) + ' байт)')) }
    const cleanup = () => { try { clearTimeout(to) } catch (e) {}; sock.removeListener('data', onData); sock.removeListener('error', onErr); sock.removeListener('end', onEnd) }
    to = setTimeout(() => { cleanup(); reject(new Error((label || 'read') + ': таймаут ' + Math.round(timeoutMs / 1000) + 'с')) }, timeoutMs)
    sock.on('data', onData); sock.on('error', onErr); sock.on('end', onEnd)
  })
}

// Полный SOCKS5-handshake своими силами: greeting -> auth -> CONNECT.
// Возвращает живой net.Socket до цели. Ошибки — человекочитаемые (для лога и --proxy-check).
function socks5Open(pxy, destHost, destPort, timeoutMs) {
  timeoutMs = timeoutMs || 15000
  return new Promise((resolve, reject) => {
    let sock = null
    try {
      sock = net.connect({ host: pxy.host, port: Number(pxy.port) })
    } catch (e) { reject(e instanceof Error ? e : new Error(String(e))); return }

    let settled = false
    let buf = Buffer.alloc(0)          // единый буфер: данные не теряются между чтениями
    let need = 0, onHave = null, onWantReject = null
    const fail = e => {
      if (settled) return
      settled = true; try { clearTimeout(to) } catch (x) {}
      const r = onWantReject; onHave = null; onWantReject = null
      try { sock.destroy() } catch (x) {}
      if (r) r(e instanceof Error ? e : new Error(String(e)))
      else reject(e instanceof Error ? e : new Error(String(e)))
    }
    const to = setTimeout(() => fail(new Error('таймаут подключения к прокси ' + Math.round(timeoutMs / 1000) + 'с')), timeoutMs)
    sock.setTimeout(timeoutMs, () => fail(new Error('таймаут сокета прокси')))
    sock.on('error', e => {
      const m = String(e.message || e); let msg = m
      if (e.code === 'ECONNREFUSED') msg = 'прокси ' + pxy.host + ':' + pxy.port + ' ОТКАЗАЛ в соединении (ECONNREFUSED) — порт не слушает: аренда истекла / прокси выключен / неверный порт'
      else if (e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN') msg = 'не удалось определить адрес ' + pxy.host + ' (' + e.code + ') — DNS/интернет'
      else if (e.code === 'ETIMEDOUT' || e.code === 'EHOSTUNREACH' || e.code === 'ENETUNREACH') msg = pxy.host + ':' + pxy.port + ' недоступен (' + e.code + ') — файрвол/провайдер блокирует порт, или прокси выключен'
      fail(new Error(msg))
    })
    const onEnd = () => fail(new Error('прокси закрыл соединение до завершения handshake'))
    sock.on('end', onEnd)
    // постоянный слушатель: копит байты, отдаёт текущему «хочу N байт»
    const onData = d => {
      buf = Buffer.concat([buf, d])
      if (onHave && buf.length >= need) {
        const chunk = buf.slice(0, need); buf = buf.slice(need)
        const cb = onHave; onHave = null; onWantReject = null
        cb(chunk)
      }
    }
    sock.on('data', onData)
    const read = (n, label) => new Promise((res, rej) => {
      if (settled) { rej(new Error(label + ': сокет уже закрыт')); return }
      if (buf.length >= n) { const c = buf.slice(0, n); buf = buf.slice(n); res(c); return }
      need = n; onHave = res; onWantReject = rej
    })

    sock.once('connect', async () => {
      try {
        const user = pxy.userId || pxy.username || ''
        const pass = pxy.password || ''
        const auth = !!(user || pass)
        sock.write(auth ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]))
        const g = await read(2, 'SOCKS greeting')
        if (g[0] !== 0x05) throw new Error('это не SOCKS5 (первый байт 0x' + g[0].toString(16) + ') — вероятно, порт HTTP-прокси')
        if (g[1] === 0xff) throw new Error('прокси не принял ни один метод авторизации (0xFF)')
        if (g[1] === 0x02) {
          const ub = Buffer.from(String(user), 'utf8'), pb = Buffer.from(String(pass), 'utf8')
          sock.write(Buffer.concat([Buffer.from([0x01, ub.length & 255]), ub, Buffer.from([pb.length & 255]), pb]))
          const ab = await read(2, 'SOCKS auth')
          if (ab[0] !== 0x01) throw new Error('мусор в ответе авторизации SOCKS')
          if (ab[1] !== 0x00) throw new Error('прокси ОТВЕРГ логин/пароль (status 0x' + ab[1].toString(16) + ')')
        }
        // CONNECT
        const h = String(destHost)
        let head
        if (isIpV4(h)) head = Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x01]), Buffer.from(h.split('.').map(x => Number(x) & 255))])
        else { const hb = Buffer.from(h, 'utf8'); head = Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, hb.length & 255]), hb]) }
        const pb = Buffer.alloc(2); pb.writeUInt16BE(Number(destPort) & 0xffff, 0)
        sock.write(Buffer.concat([head, pb]))
        const rp = await read(4, 'SOCKS reply')
        if (rp[0] !== 0x05) throw new Error('мусор в ответе SOCKS (0x' + rp[0].toString(16) + ')')
        const code = rp[1]
        if (code !== 0x00) {
          const names = { 1: 'общий сбой прокси', 2: 'соединение ЗАПРЕЩЕНО правилами прокси', 3: 'сеть недоступна', 4: 'хост недоступен', 5: 'отказано в соединении с целью', 6: 'TTL истёк', 7: 'команда не поддержана', 8: 'тип адреса не поддержан' }
          throw new Error('SOCKS5 отказ 0x' + code.toString(16) + ' — ' + (names[code] || 'неизвестно') + (code === 2 ? ' (обычно неверный логин/пароль или привязка по IP)' : '') + (code === 5 ? ' (цель ' + destHost + ':' + destPort + ' не пускает)' : ''))
        }
        const at = rp[3]
        if (at === 1) await read(4 + 2, 'SOCKS bind')
        else if (at === 4) await read(16 + 2, 'SOCKS bind')
        else if (at === 3) { const lb = await read(1, 'SOCKS bind-len'); await read(lb[0] + 2, 'SOCKS bind') }
        else throw new Error('непонятный тип адреса 0x' + at.toString(16))

        // handshake завершён: снимаем свой слушатель и возвращаем «лишние» байты в сокет,
        // чтобы mineflayer получил всё, что сервер прислал сразу за SOCKS-ответом.
        if (settled) return
        settled = true; clearTimeout(to); try { sock.setTimeout(0) } catch (e) {}
        sock.removeListener('data', onData)
        sock.removeListener('end', onEnd)
        if (buf.length) { try { sock.unshift(buf) } catch (e) {} }
        buf = Buffer.alloc(0)
        resolve(sock)
      } catch (e) { fail(e) }
    })
  })
}

// HTTP-запрос через уже открытый туннель (сокеты после socks5Open / httpConnect)
function httpThrough(sock, host, reqText, timeoutMs) {
  timeoutMs = timeoutMs || 10000
  return new Promise(resolve => {
    let data = '', fin = false
    const end = v => { if (fin) return; fin = true; try { clearTimeout(t) } catch (e) {}; try { sock.destroy() } catch (e) {}; resolve(v) }
    const t = setTimeout(() => end(data), timeoutMs)
    sock.on('data', d => {
      data += d.toString('utf8')
      if (data.indexOf('\r\n\r\n') >= 0) {
        const body = data.split('\r\n\r\n').slice(1).join('\r\n\r\n')
        if (body.trim()) end(body.trim())
      }
      if (data.length > 200000) end(data)
    })
    sock.on('error', () => end(data))
    sock.on('end', () => end(data))
    try { sock.write(reqText) } catch (e) { end('') }
  })
}

// HTTP-прокси методом CONNECT (mproxy.site — тот же порт, но протокол HTTP)
function httpConnect(pxy, destHost, destPort, timeoutMs) {
  timeoutMs = timeoutMs || 15000
  return new Promise((resolve, reject) => {
    let sock = null
    try { sock = net.connect({ host: pxy.host, port: Number(pxy.port) }) } catch (e) { reject(e); return }
    let done = false
    const fail = e => { if (done) return; done = true; try { clearTimeout(to) } catch (x) {}; try { sock.destroy() } catch (x) {}; reject(e instanceof Error ? e : new Error(String(e))) }
    const to = setTimeout(() => fail(new Error('таймаут HTTP CONNECT ' + Math.round(timeoutMs / 1000) + 'с')), timeoutMs)
    sock.once('error', e => fail(new Error('HTTP-прокси ' + pxy.host + ':' + pxy.port + ': ' + (e.code === 'ECONNREFUSED' ? 'ОТКАЗ в соединении (порт не слушает)' : e.message))))
    let head = 'CONNECT ' + destHost + ':' + destPort + ' HTTP/1.1\r\nHost: ' + destHost + ':' + destPort + '\r\n'
    if (pxy.userId || pxy.username) head += 'Proxy-Authorization: Basic ' + Buffer.from((pxy.userId || pxy.username) + ':' + (pxy.password || '')).toString('base64') + '\r\n'
    head += '\r\n'
    sock.once('connect', () => { try { sock.write(head) } catch (e) { fail(e) } })
    let buf = Buffer.alloc(0)
    const onData = d => {
      buf = Buffer.concat([buf, d])
      const i = buf.indexOf('\r\n\r\n')
      if (i < 0) { if (buf.length > 65536) fail(new Error('HTTP-прокси: мусор вместо ответа CONNECT')); return }
      sock.removeListener('data', onData)
      const line = buf.slice(0, i).toString('latin1').split('\r\n')[0]
      if (done) return
      done = true; clearTimeout(to)
      if (!/ 200\b/.test(line)) { try { sock.destroy() } catch (e) {}; reject(new Error('HTTP-прокси ответил «' + line.slice(0, 60) + '»' + (/ 407\b/.test(line) ? ' — неверный логин/пароль' : ''))); return }
      const rest = buf.slice(i + 4)          // «лишние» байты — назад в сокет без потерь
      if (rest.length) { try { sock.unshift(rest) } catch (e) {} }
      resolve(sock)
    }
    sock.on('data', onData)
  })
}

// туннель к цели: сначала SOCKS5, при неудаче — HTTP CONNECT (если host похож на mproxy)
async function proxyTunnel(destHost, destPort, opt) {
  opt = opt || {}
  const pxy = { host: opt.host || PROXY.host, port: opt.port || PROXY.port, userId: opt.username !== undefined ? opt.username : PROXY.username, password: opt.password !== undefined ? opt.password : PROXY.password }
  const timeoutMs = opt.timeoutMs || 15000
  if (!pxy.host) throw new Error('нет proxy.host в конфиге')
  if (opt.method === 'http') return await httpConnect(pxy, destHost, destPort, timeoutMs)
  try {
    return await socks5Open(pxy, destHost, destPort, timeoutMs)
  } catch (e) {
    const alt = opt.allowAlt === false ? null : altHostOf(pxy.host)
    if (alt && /ОТКАЗАЛ|не удалось определить|недоступен|не SOCKS5/i.test(e.message)) {
      try { return await httpConnect(Object.assign({}, pxy, { host: alt }), destHost, destPort, timeoutMs) } catch (e2) { throw e }
    }
    throw e
  }
}

async function socksHttpGet2(host, reqText, opt) {
  const sock = await proxyTunnel(host, 80, opt)
  return await httpThrough(sock, host, reqText, (opt && opt.timeoutMs) || 10000)
}

let PROXY_OK_HOST = null          // хост, через который реально удалось пройти
let PROXY_STATE = 'unknown'       // unknown | alive | dead
const PROXY_ERRS = []             // последние ошибки (для --proxy-check и Telegram-чата)
function rememberProxyErr(host, e) {
  PROXY_ERRS.push({ host: host || PROXY.host, msg: String((e && e.message) || e), ts: Date.now() })
  if (PROXY_ERRS.length > 12) PROXY_ERRS.shift()
}

// живой прокси: пробуем запомненный хост, затем из конфига, затем запасной (mproxy/bproxy)
async function proxyConnect(destHost, destPort, timeoutMs) {
  const hosts = proxyHostCandidates()
  let last = null
  for (const h of hosts) {
    try {
      const sock = await socks5Open({ host: h, port: PROXY.port, userId: PROXY.username, password: PROXY.password }, destHost, destPort, timeoutMs || 15000)
      if (PROXY_OK_HOST !== h) {
        if (PROXY_OK_HOST) step('прокси: хост ' + (PROXY_OK_HOST) + ' не отвечает — работаю через ' + h)
        PROXY_OK_HOST = h
      }
      PROXY_STATE = 'alive'
      return sock
    } catch (e) { last = e; rememberProxyErr(h, e) }
  }
  PROXY_STATE = 'dead'
  throw last || new Error('прокси недоступен')
}

// внешний IP: через прокси (это IP забега), при неудаче — напрямую (чтобы в логе не было «?»)
async function currentIp(opts) {
  opts = opts || {}
  if (!opts.directOnly) {
    try {
      const body = await socksHttpGet2('api.ipify.org', 'GET / HTTP/1.1\r\nHost: api.ipify.org\r\nUser-Agent: curl/8.0\r\nConnection: close\r\n\r\n', { timeoutMs: opts.timeoutMs || 10000 })
      const m = String(body || '').trim().match(/^\s*(\d{1,3}(?:\.\d{1,3}){3})\s*$/)
      if (m) { PROXY_STATE = 'alive'; return m[1] }
    } catch (e) { if (!PROXY_ERRS.length || PROXY_ERRS[PROXY_ERRS.length - 1].msg !== String(e.message)) rememberProxyErr(PROXY_OK_HOST || PROXY.host, e) }
  }
  if (opts.proxyOnly) return null
  try {
    const r = await plainGet('https://api.ipify.org', 8000)
    const m = String(r.body || '').trim().match(/^<?\s*(\d{1,3}(?:\.\d{1,3}){3})\s*>?$/)
    if (m) { if (opts.tagDirect !== false) step('IP определён НАПРЯМУЮ (прокси не отвечает): ' + m[1]); return m[1] }
  } catch (e) {}
  return null
}

// разбираем ответ ссылки смены IP. Чистые функции — покрыты selftest.
function parseChangeIpResponse(status, body, url) {
  const out = { status: Number(status) || 0, kind: 'unknown', newIp: null, rt: null, rateLimited: false, title: '', text: '', hint: '' }
  const raw = String(body == null ? '' : body)
  out.text = raw.replace(/\s+/g, ' ').trim().slice(0, 200)
  const low = raw.toLowerCase()
  if (low.indexOf('<!doctype html') >= 0 || low.indexOf('<html') >= 0) {
    out.kind = 'html'
    const t = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
    out.title = t ? t[1].replace(/\s+/g, ' ').trim().slice(0, 90) : ''
    const isMps = /mobileproxy\.space|changeip\./i.test(String(url || ''))
    out.hint = isMps
      ? 'ссылка вернула ВЕБ-СТРАНИЦУ («' + (out.title || 'без заголовка') + '»), а не ответ API. Возьмите ссылку в панели «Мои прокси» → колонка «Смена IP» и добавьте &format=json'
      : 'ссылка вернула ВЕБ-СТРАНИЦУ («' + (out.title || 'без заголовка') + '»), а не JSON/текст — похоже, это не API смены IP (или нужна авторизация)'
    return out
  }
  const jm = raw.match(/\{[\s\S]*\}/)
  if (jm) {
    try {
      const j = JSON.parse(jm[0])
      out.kind = 'json'
      out.newIp = isIpV4(j.new_ip || j.newIp || j.ip || j.newip) ? String(j.new_ip || j.newIp || j.ip || j.newip) : null
      out.rt = j.rt !== undefined ? String(j.rt) : null
      out.status0 = j.status !== undefined ? String(j.status) : null
      const s = String(j.status || j.error || j.message || '').toLowerCase()
      if (/30\s*(сек|sec|second)|часто|too\s*often|rate|limit|ждите|подождите/i.test(s + ' ' + out.text.toLowerCase())) out.rateLimited = true
      if (!out.newIp) { const m = out.text.match(/(\d{1,3}(?:\.\d{1,3}){3})/); if (m && isIpV4(m[1])) out.newIp = m[1] }
      if (out.rateLimited) out.hint = 'прокси меняет IP не чаще раза в 30 секунд — запрос отброшен, ждём'
      else if (j.status && !/^ok$/i.test(String(j.status))) out.hint = 'API ответил status=' + j.status + (j.error ? ' error=' + j.error : '')
      return out
    } catch (e) { /* не JSON — падём ниже */ }
  }
  const m = raw.match(/(\d{1,3}(?:\.\d{1,3}){3})/)
  if (m && isIpV4(m[1])) { out.kind = 'ip'; out.newIp = m[1]; return out }
  if (/30\s*(сек|sec|second)|часто|too\s*often|rate|limit/i.test(low)) { out.kind = 'rate'; out.rateLimited = true; out.hint = 'слишком частая смена IP (лимит 30 секунд)'; return out }
  if (/ok|success|changed|сменен|изменен/i.test(low)) { out.kind = 'ok-text'; return out }
  out.kind = raw.trim() ? 'text' : 'empty'
  if (!raw.trim()) out.hint = 'пустой ответ — ссылка не сработала'
  return out
}

// дописать format=json к ссылке смены IP (MobileProxy.Space умеет отдавать JSON)
function ensureJsonParam(url) {
  const u = String(url || '')
  if (!u) return u
  if (/[?&]format=/i.test(u)) return u
  return u + (u.indexOf('?') >= 0 ? '&' : '?') + 'format=json'
}
// человекочитаемое «что это за ссылка»
function describeChangeIpUrl(u) {
  const s = String(u || '')
  if (!s) return 'не задана (proxy.changeIpUrl)'
  if (/changeip\.mobileproxy\.space/i.test(s)) return 'API MobileProxy.Space (changeip.mobileproxy.space)'
  if (/mobileproxy\.space/i.test(s)) return 'сайт MobileProxy.Space'
  try { const p = new URL(s); return p.host + p.pathname } catch (e) { return s.slice(0, 60) }
}

let lastChangeAt = 0        // ссылка смены IP: минимум 30 секунд между запросами (лимит провайдера)
let lastChangeWasLimited = false
const CHANGE_IP_MIN_MS = 30000

// Быстрая проверка «жив ли прокси» — до старта, чтобы не жечь 6 ротаций впустую.
async function proxyAlive(timeoutMs) {
  if (!PROXY.host) return false
  try { await proxyConnect('api.ipify.org', 80, timeoutMs || 7000); return true } catch (e) { return false }
}

// подсказка к ошибке прокси — прямо в лог раунда (раньше было просто «socks: ...»)
function socksHint(msg) {
  const s = String(msg || '')
  if (/ConnectionRefused|ECONNREFUSED|ОТКАЗАЛ/i.test(s)) return [
    '🔌 прокси ' + (PROXY_OK_HOST || PROXY.host) + ':' + PROXY.port + ' не принимает соединения (порт не слушает).',
    '   Чаще всего это значит: аренда мобильного прокси истекла или порт выключен.',
    '   Что сделать:',
    '     1) node main.js --proxy-check   — полная диагностика (DNS, SOCKS5, HTTP-резерв, ссылка смены IP, пинг MC-сервера)',
    '     2) панель провайдера → «Мои прокси»: проверить срок аренды, нажать «Renew» / «Перезагрузить оборудование» / «Сменить оборудование»',
    '     3) сверить proxy.host / proxy.port / логин / пароль в config.json со свежими данными из панели',
    '     4) если прокси больше не нужен — уберите секцию proxy из config.json (бот пойдёт напрямую)'
  ].join('\n')
  if (/ОТВЕРГ логин|407|неверный логин|ПРАВИЛАМИ|запрещено|0x02/i.test(s)) return [
    '🔐 прокси не принял авторизацию/правила.',
    '   Проверьте proxy.username и proxy.password в config.json (свежие — в панели провайдера),',
    '   и не включена ли у провайдера привязка по IP (тогда ваш IP нужно добавить в белый список).',
    '   Диагностика: node main.js --proxy-check'
  ].join('\n')
  if (/ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|недоступен|таймаут/i.test(s)) return [
    '⏳ прокси ' + (PROXY_OK_HOST || PROXY.host) + ':' + PROXY.port + ' не отвечает (таймаут/недоступен).',
    '   Варианты: прокси выключен, ваш провайдер/файрвол блокирует исходящие на этот порт,',
    '   или оборудование «зависло» — в панели провайдера нажмите «Перезагрузить оборудование».',
    '   Диагностика: node main.js --proxy-check'
  ].join('\n')
  if (/не SOCKS5|первый байт/i.test(s)) return [
    '🔀 порт отвечает, но это не SOCKS5. У MobileProxy.space порт один на два протокола:',
    '   SOCKS5-хост bproxy.site, HTTP-хост mproxy.site. Бот пробует оба сам.',
    '   Диагностика: node main.js --proxy-check'
  ].join('\n')
  if (/ENOTFOUND|EAI_AGAIN|определить адрес/i.test(s)) return [
    '🌐 не удалось определить адрес ' + (PROXY_OK_HOST || PROXY.host) + ' (DNS).',
    '   Проверьте интернет и DNS; при необходимости пропишите proxy.host IP-адресом из панели.'
  ].join('\n')
  return ''
}

async function rotateIp(opt) {
  opt = opt || {}
  const url = String(PROXY.changeIpUrl || '').trim()
  if (!url || url.includes('YOUR_KEY')) { currentRunIp = await currentIp(); return currentRunIp }

  // сначала убеждаемся, что прокси вообще жив: иначе «IP не сменился» — это не про IP,
  // а про то, что спросить не у кого (в логе 21:19 было именно так: везде «?»)
  const alive = await proxyAlive(7000)
  if (!alive) {
    step('⚠️ прокси ' + (PROXY_OK_HOST || PROXY.host) + ':' + PROXY.port + ' НЕ отвечает — IP через него не узнать' + (PROXY_ERRS.length ? ' (' + PROXY_ERRS[PROXY_ERRS.length - 1].msg.slice(0, 120) + ')' : ''))
    if (!opt.quiet) { const h = socksHint(PROXY_ERRS.length ? PROXY_ERRS[PROXY_ERRS.length - 1].msg : 'ECONNREFUSED'); if (h) h.split('\n').forEach(l => step('   ' + l)) }
  }

  for (let round = 1; round <= 2; round++) {
    const oldIp = await currentIp({ quiet: true })
    step('IP до ротации: ' + (oldIp || '?') + (PROXY_STATE === 'dead' ? ' (напрямую — прокси мёртв)' : ''))

    // лимит провайдера: 30 секунд между сменами IP (иначе запрос молча отбрасывается)
    const since = Date.now() - lastChangeAt
    if (lastChangeAt && since < CHANGE_IP_MIN_MS && !opt.force) {
      const w = Math.ceil((CHANGE_IP_MIN_MS - since) / 1000)
      step('⏱ смена IP была ' + Math.round(since / 1000) + 'с назад — лимит провайдера 30с, жду ' + w + 'с')
      await sleep(CHANGE_IP_MIN_MS - since + 300)
    }

    // API MobileProxy.Space отдаёт JSON, если попросить format=json, и требует браузерный User-Agent
    const reqUrl = ensureJsonParam(url)
    if (reqUrl !== url) dbg('changeIp: добавил format=json → ' + reqUrl.slice(0, 120))
    let res = null, p = null, hit = 'fail'
    for (let t = 1; t <= 2; t++) {
      try {
        res = await plainGet(reqUrl, 15000)
        p = parseChangeIpResponse(res.status, res.body, reqUrl)
        hit = 'HTTP ' + res.status + ' → ' + p.kind +
          (p.newIp ? ' new_ip=' + p.newIp : '') + (p.rt ? ' rt=' + p.rt + 'с' : '') +
          (p.title ? ' title=«' + p.title + '»' : '') +
          (p.kind === 'text' || p.kind === 'ok-text' ? ' «' + p.text.slice(0, 60) + '»' : '')
        if (res.status >= 200 && res.status < 400 && p.kind !== 'html' && p.kind !== 'empty') break
        if (p.kind === 'html' || p.kind === 'empty') break   // повторять бессмысленно — ссылка не та
      } catch (e) { hit = 'ERR ' + ((e && e.message) || e); p = null }
      if (t < 2) { step('changeIp: ' + hit + ' — повтор через 3с'); await sleep(3000) }
    }
    lastChangeAt = Date.now()
    step('changeIp (' + describeChangeIpUrl(reqUrl) + '): ' + hit)
    if (p && p.hint) step('  ℹ️ ' + p.hint)
    if (p && p.kind === 'html') {
      step('  ⚠️ IP так НЕ меняют: сервер отдал веб-страницу. Нужна ссылка из панели «Мои прокси» → колонка «Смена IP»' +
        ' (вид https://changeip.mobileproxy.space/?proxy_key=XXXX), желательно с &format=json.')
      step('  ⚠️ Без рабочей смены IP бот будет каждый раз заходить с одного и того же адреса — FunTime его быстро забанит.')
      // ссылка заведомо не рабочая — ждать смену и крутить второй круг бессмысленно
      currentRunIp = oldIp || await currentIp({ quiet: true })
      return currentRunIp
    }
    lastChangeWasLimited = !!(p && p.rateLimited)

    // ждём подтверждения: сначала из ответа API (быстро и не зависит от прокси), потом опросом
    const t0 = Date.now(); let newIp = (p && p.newIp) || null
    const waitMs = Math.max(8000, (Number(PROXY.waitSec) || 12) * 1000) * (lastChangeWasLimited ? 2 : 1)
    while (!(newIp && (!oldIp || newIp !== oldIp)) && Date.now() - t0 < waitMs) {
      await sleep(2000)
      const q = await currentIp({ quiet: true })
      if (q && (!oldIp || q !== oldIp)) newIp = q
    }
    if (newIp && (!oldIp || newIp !== oldIp)) {
      if (oldIp && badIPs.has(newIp)) { step('новый IP ' + newIp + ' уже плох — кручу'); continue }
      step('IP СМЕНЁН: ' + (oldIp || '?') + ' -> ' + newIp + (PROXY_STATE === 'dead' ? ' (⚠️ сам прокси по-прежнему не отвечает — раунд не подключится)' : ''))
      currentRunIp = newIp; return newIp
    }
    if (PROXY_STATE === 'dead') step('IP не сменился: прокси мёртв, проверить смену нечем → node main.js --proxy-check')
    else step('IP не сменился' + (lastChangeWasLimited ? ' (лимит 30с — следующий запрос пройдёт)' : ' (провайдер иногда выдаёт тот же адрес — это нормально, пробую ещё раз)'))
  }
  currentRunIp = await currentIp({ quiet: true }); return currentRunIp
}

// ========================= ДИАГНОСТИКА ПРОКСИ: node main.js --proxy-check =========================
async function mcStatusPing(sock, timeoutMs) {
  const varint = n => { const b = []; do { let x = n & 0x7f; n >>>= 7; if (n) x |= 0x80; b.push(x) } while (n); return Buffer.from(b) }
  const pkt = body => Buffer.concat([varint(body.length), body])
  const hsBody = Buffer.concat([
    varint(0x00), varint(767), varint(Buffer.byteLength(MC.host)), Buffer.from(MC.host, 'utf8'),
    (() => { const b = Buffer.alloc(2); b.writeUInt16BE(MC.port, 0); return b })(), varint(1)
  ])
  return new Promise(resolve => {
    let done = false, buf = Buffer.alloc(0), t0 = Date.now()
    const fin = r => { if (done) return; done = true; try { clearTimeout(to) } catch (e) {}; try { sock.destroy() } catch (e) {}; resolve(r) }
    const to = setTimeout(() => fin({ ok: false, err: 'таймаут ' + Math.round((timeoutMs || 12000) / 1000) + 'с' }), timeoutMs || 12000)
    sock.on('error', e => fin({ ok: false, err: e.message }))
    sock.on('data', d => {
      buf = Buffer.concat([buf, d])
      if (buf.length < 3) return
      let len = 0, shift = 0, i = 0
      for (; i < Math.min(5, buf.length); i++) { const b = buf[i]; len |= (b & 0x7f) << shift; shift += 7; if (!(b & 0x80)) { i++; break } }
      if (buf.length < i + len) return
      const s = buf.slice(i, i + len).toString('utf8')
      const m = s.match(/\{[\s\S]*\}/)
      if (m) {
        let j = null; try { j = JSON.parse(m[0]) } catch (e) {}
        fin({ ok: true, ms: Date.now() - t0, json: j })
      } else fin({ ok: true, ms: Date.now() - t0, raw: s.slice(0, 120) })
    })
    try { sock.write(Buffer.concat([pkt(hsBody), pkt(Buffer.from([0x00]))])) } catch (e) { fin({ ok: false, err: 'write: ' + e.message }) }
  })
}

async function runProxyCheck() {
  const L = []
  const say = s => { L.push(s); step(s) }
  say('=== ДИАГНОСТИКА ПРОКСИ (v3.13.0) ===')
  if (!PROXY.host) {
    say('❌ в config.json нет proxy.host — бот ходит на сервер НАПРЯМУЮ.')
    say('   Если FunTime банит ваш IP, пропишите мобильный прокси: "proxy": { "host": "bproxy.site", "port": 23750, "username": "...", "password": "..." }')
    return false
  }
  say('прокси из config.json : ' + PROXY.host + ':' + PROXY.port + ' | логин ' + (PROXY.username ? '«' + PROXY.username + '» (есть)' : 'НЕТ') + ' | пароль ' + (PROXY.password ? 'есть' : 'НЕТ'))
  say('ссылка смены IP       : ' + describeChangeIpUrl(PROXY.changeIpUrl) + (PROXY.changeIpUrl ? ' → ' + PROXY.changeIpUrl : ''))
  say('модуль socks          : ' + (SocksClient ? 'установлен' : 'НЕТ (используется встроенный SOCKS5-клиент)'))

  // 1. DNS
  const hosts = proxyHostCandidates(PROXY.host)
  say('')
  say('--- 1. DNS ---')
  for (const h of hosts) {
    const ips = await new Promise(r => dns.lookup(h, { all: true, verbatim: true }, (e, a) => r(e ? null : a.map(x => x.address))))
    say('  ' + h.padEnd(22) + (ips ? '→ ' + ips.join(', ') : '❌ не определяется (нет интернета/DNS или домен не существует)'))
  }

  // 2. прямой интернет
  say('')
  say('--- 2. интернет без прокси ---')
  const directIp = await currentIp({ directOnly: true })
  say('  ' + (directIp ? '✅ ваш IP напрямую: ' + directIp : '❌ не удалось выйти в интернет даже напрямую (api.ipify.org недоступен) — проверьте сеть/файрвол'))

  // 3. SOCKS5 по всем кандидатам
  say('')
  say('--- 3. SOCKS5 handshake (подключение к api.ipify.org:80) ---')
  let liveHost = null, liveIp = null, errs = []
  for (const h of hosts) {
    const t0 = Date.now()
    try {
      const sock = await socks5Open({ host: h, port: PROXY.port, userId: PROXY.username, password: PROXY.password }, 'api.ipify.org', 80, 10000)
      const body = await httpThrough(sock, 'api.ipify.org', 'GET / HTTP/1.1\r\nHost: api.ipify.org\r\nUser-Agent: curl/8.0\r\nConnection: close\r\n\r\n', 10000)
      const ip = String(body || '').trim()
      say('  ✅ ' + h + ':' + PROXY.port + ' РАБОТАЕТ за ' + (Date.now() - t0) + 'мс → внешний IP ' + (isIpV4(ip) ? ip : '«' + ip.slice(0, 40) + '»'))
      if (!liveHost) { liveHost = h; liveIp = isIpV4(ip) ? ip : null }
    } catch (e) { errs.push({ host: h, msg: String(e.message || e) }); say('  ❌ ' + h + ':' + PROXY.port + ' — ' + String(e.message || e).slice(0, 160)) }
  }

  // 4. HTTP CONNECT на запасном хосте
  if (!liveHost) {
    const alt = altHostOf(PROXY.host) || PROXY.host
    say('')
    say('--- 4. HTTP CONNECT (протокол HTTP на том же порту) ---')
    const t0 = Date.now()
    try {
      const sock = await httpConnect({ host: alt, port: PROXY.port, userId: PROXY.username, password: PROXY.password }, 'api.ipify.org', 80, 10000)
      const body = await httpThrough(sock, 'api.ipify.org', 'GET / HTTP/1.1\r\nHost: api.ipify.org\r\nUser-Agent: curl/8.0\r\nConnection: close\r\n\r\n', 10000)
      const ip = String(body || '').trim()
      say('  ✅ HTTP-прокси ' + alt + ':' + PROXY.port + ' работает за ' + (Date.now() - t0) + 'мс → ' + ip.slice(0, 40))
      say('  ℹ️ значит прокси ЖИВ, но в config.json нужен host=' + alt + ' (SOCKS5-порт у провайдера может отличаться)')
    } catch (e) { say('  ❌ ' + alt + ':' + PROXY.port + ' — ' + String(e.message || e).slice(0, 160)) }
  }

  // 5. внешний IP через прокси (после выбора живого хоста)
  if (liveHost) { PROXY_OK_HOST = liveHost; PROXY_STATE = 'alive' } else PROXY_STATE = 'dead'
  say('')
  say('--- 5. внешний IP ---')
  say('  через прокси : ' + (liveIp || '—') + (liveHost ? '  (хост ' + liveHost + ')' : ''))
  say('  напрямую     : ' + (directIp || '—'))
  if (liveIp && directIp) say(liveIp === directIp ? '  ⚠️ IP совпадают — прокси не подменяет адрес (трафик идёт мимо него?)' : '  ✅ IP разные — трафик действительно идёт через прокси')

  // 6. ссылка смены IP
  say('')
  say('--- 6. ссылка смены IP ---')
  let ch = null, chUrl = ''
  if (!PROXY.changeIpUrl || /YOUR_KEY/.test(PROXY.changeIpUrl)) {
    say('  ⚠️ proxy.changeIpUrl не задан — IP меняться не будет, бот каждый раз заходит с одного адреса')
  } else {
    chUrl = ensureJsonParam(PROXY.changeIpUrl)
    say('  проверяю: ' + chUrl + (chUrl !== PROXY.changeIpUrl ? '   (автоматически добавил format=json)' : ''))
    const t0 = Date.now()
    try {
      const r = await plainGet(chUrl, 15000)
      ch = parseChangeIpResponse(r.status, r.body, chUrl)
      say('  HTTP ' + r.status + ' за ' + (Date.now() - t0) + 'мс → ответ: ' + ch.kind + (ch.newIp ? ', new_ip=' + ch.newIp : '') + (ch.rt ? ', rt=' + ch.rt + 'с' : '') + (ch.title ? ', title=«' + ch.title + '»' : ''))
      if (ch.text && ch.kind !== 'html') say('  текст: «' + ch.text.slice(0, 140) + '»')
      if (ch.kind === 'html') say('  ❌ это ВЕБ-СТРАНИЦА, а не ответ API — IP так не меняется. ' + ch.hint)
      else if (ch.rateLimited) say('  ⚠️ ' + ch.hint + ' (это не ошибка, просто подождите)')
      else if (ch.newIp) say('  ✅ ссылка рабочая, провайдер выдал ' + ch.newIp)
      else if (ch.kind === 'ok-text' || ch.kind === 'json') say('  ✅ ссылка отвечает; новый IP придёт следующим запросом (лимит 30 секунд)')
      else say('  ⚠️ ответ непонятный — сверьте ссылку с панелью провайдера')
    } catch (e) { say('  ❌ запрос не прошёл: ' + String(e.message || e).slice(0, 160)) }
    if (liveHost && ch && ch.newIp) {
      await sleep(4000)
      const nowIp = await currentIp({ proxyOnly: true, timeoutMs: 10000 })
      say('  проверка через прокси: текущий IP ' + (nowIp || '?') + (nowIp === ch.newIp ? ' ✅ совпал с new_ip' : (nowIp ? ' (отличается — провайдер ещё меняет адрес или new_ip устарел)' : '')))
    } else if (!liveHost) say('  ℹ️ проверить смену IP через прокси не могу — прокси не отвечает')
  }

  // 7. пинг MC-сервера через прокси
  say('')
  say('--- 7. Minecraft-сервер через прокси ---')
  if (!liveHost) say('  ⏭ пропущено: нет живого прокси')
  else {
    const t0 = Date.now()
    try {
      const sock = await socks5Open({ host: liveHost, port: PROXY.port, userId: PROXY.username, password: PROXY.password }, MC.host, MC.port, 15000)
      const r = await mcStatusPing(sock, 12000)
      if (r.ok) {
        const v = r.json && (r.json.version || {})
        say('  ✅ ' + MC.host + ':' + MC.port + ' отвечает через прокси за ' + r.ms + 'мс' + (v.name ? ' (сервер: ' + v.name + ', protocol ' + v.protocol + ')' : ''))
        const pl = r.json && r.json.players
        if (pl) say('     игроков: ' + pl.online + '/' + pl.max)
      } else say('  ❌ туннель открылся, но сервер не ответил на status-пинг: ' + r.err)
    } catch (e) { say('  ❌ не удалось: ' + String(e.message || e).slice(0, 160)) }
    say('  (замер ' + (Date.now() - t0) + 'мс)')
  }

  // 8. вердикт
  say('')
  say('=== ВЕРДИКТ ===')
  if (liveHost) {
    say('✅ ПРОКСИ ЖИВ: ' + liveHost + ':' + PROXY.port + ', внешний IP ' + (liveIp || '?') + '.')
    if (ch && ch.kind === 'html') say('⚠️ осталось починить смену IP: замените proxy.changeIpUrl на ссылку из панели «Мои прокси» → «Смена IP» (вид https://changeip.mobileproxy.space/?proxy_key=XXXX&format=json).')
    else if (!chUrl) say('⚠️ добавьте proxy.changeIpUrl — иначе после бана IP бот не сможет его сменить.')
    else say('Можно запускать: node main.js --rounds 10')
    return true
  }
  const refused = errs.filter(e => /ОТКАЗАЛ|ECONNREFUSED/i.test(e.msg)).length
  if (refused >= 1 && errs.length === hosts.length) {
    say('❌ ПРОКСИ МЁРТВ: ни ' + hosts.join(', ') + ' на порту ' + PROXY.port + ' не принимают TCP-соединение.')
    say('   Это НЕ ошибка бота: на том конце никто не слушает порт. Диагноз в 9 случаях из 10:')
    say('     • аренда мобильного прокси ИСТЕКЛА → панель «Мои прокси» → включить «Показать истёкшие» → «Продлить»')
    say('     • оборудование выключено/зависло → «Операции» → «Перезагрузить оборудование», затем «Сменить оборудование»')
    say('     • порт/логин/пароль в config.json не совпадают с тем, что сейчас в панели')
    say('   Пока прокси не оживёт, раунды будут падать с «socks fail: ... ConnectionRefused», а ротация IP бессмысленна.')
    if (directIp) say('   Временно можно убрать секцию proxy из config.json — бот пойдёт напрямую с IP ' + directIp + ' (FunTime может быстро забанить такой IP).')
  } else {
    say('❌ прокси не работает. Ошибки по хостам:')
    for (const e of errs) say('   • ' + e.host + ' — ' + e.msg.slice(0, 160))
    say('   Проверьте: прокси включён в панели? порт тот же? логин/пароль свежие? ваш провайдер не блокирует исходящие на порт ' + PROXY.port + '?')
  }
  return false
}

// ========================= РАСПОЗНАВАТЕЛЬ ЦИФР (встроен, без внешних файлов) =========================
// Всё, что раньше лежало в digits.js. Встроено в main.js, чтобы один файл
// работал всегда, даже если рядом ничего больше не скопировали.
const DIG = (function () {
  'use strict'


const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

// ------------------------- параметры -------------------------
const GW = 20            // ширина нормализованного глифа
const GH = 28            // высота нормализованного глифа
const ZONES = 4          // зонная плотность ZONES×ZONES
const FEAT_DIM = GW * GH + ZONES * ZONES + 3
const KNN_K = 5
const CONF_OK = 0.62         // порог «доверяем ответу»
const CONF_QUEUE = 0.85      // выше этого — в очередь на разметку не попадаем
const CONF_QUEUE_MIN = 0.85

// ------------------------- PNG (минимальный, без зависимостей) -------------------------
let CRC = null
function crc32(b) {
  if (!CRC) {
    CRC = []
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); CRC[n] = c >>> 0 }
  }
  let c = 0xffffffff
  for (let i = 0; i < b.length; i++) c = (c >>> 8) ^ CRC[(c ^ b[i]) & 0xff]
  return (c ^ 0xffffffff) >>> 0
}
function pngChunk(t, d) {
  const l = Buffer.alloc(4); l.writeUInt32BE(d.length, 0)
  const tt = Buffer.from(t, 'ascii')
  const cr = Buffer.alloc(4); cr.writeUInt32BE(crc32(Buffer.concat([tt, d])), 0)
  return Buffer.concat([l, tt, d, cr])
}
function pngHeader(w, h, colorType) {
  const ih = Buffer.alloc(13)
  ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = colorType
  return ih
}
// gray8
function pngGray(w, h, scale, pixelFn) {
  const SW = w * scale, SH = h * scale
  const raw = Buffer.alloc((SW + 1) * SH)
  for (let y = 0; y < SH; y++) {
    raw[y * (SW + 1)] = 0
    const sy = Math.floor(y / scale)
    for (let x = 0; x < SW; x++) raw[y * (SW + 1) + 1 + x] = pixelFn(Math.floor(x / scale), sy)
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', pngHeader(SW, SH, 0)), pngChunk('IDAT', zlib.deflateSync(raw, 6)), pngChunk('IEND', Buffer.alloc(0))])
}
// rgba8
function pngRgba(w, h, scale, pixelFn) {
  const SW = w * scale, SH = h * scale
  const rgba = Buffer.alloc(SW * SH * 4)
  for (let y = 0; y < SH; y++) {
    const sy = Math.floor(y / scale)
    for (let x = 0; x < SW; x++) {
      const c = pixelFn(Math.floor(x / scale), sy)
      const i = (y * SW + x) * 4
      rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = 255
    }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', pngHeader(SW, SH, 6)), pngChunk('IDAT', zlib.deflateSync(rgba, 6)), pngChunk('IEND', Buffer.alloc(0))])
}
function pngFromNorm(norm, scale) {
  return pngGray(GW, GH, scale || 8, (x, y) => Math.max(0, Math.min(255, Math.round(255 * (1 - norm[y * GW + x])))))
}
function pngFromMask(mask, W, H, bbox, scale) {
  const bw = bbox.mxX - bbox.mnX + 1, bh = bbox.mxY - bbox.mnY + 1
  return pngGray(bw, bh, scale || 3, (x, y) => mask[(bbox.mnY + y) * W + bbox.mnX + x] ? 30 : 255)
}

// ------------------------- выделение глифов -------------------------
const NB8 = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]

function components8(mask, W, H) {
  const vis = new Uint8Array(mask.length)
  const out = []
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x
    if (!mask[i] || vis[i]) continue
    const st = [x, y]; vis[i] = 1
    let a = 0, mnX = x, mxX = x, mnY = y, mxY = y
    const px = []
    while (st.length) {
      const cy = st.pop(), cx = st.pop()
      a++; px.push(cy * W + cx)
      if (cx < mnX) mnX = cx; if (cx > mxX) mxX = cx
      if (cy < mnY) mnY = cy; if (cy > mxY) mxY = cy
      for (const nb of NB8) {
        const nx = cx + nb[0], ny = cy + nb[1]
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
        const ni = ny * W + nx
        if (mask[ni] && !vis[ni]) { vis[ni] = 1; st.push(nx, ny) }
      }
    }
    out.push({ a, mnX, mxX, mnY, mxY, px })
  }
  return out
}

// нормализация глифа в GW×GH со взвешиванием по площади
function normalizeGlyph(mask, W, H, c) {
  const bw = c.mxX - c.mnX + 1, bh = c.mxY - c.mnY + 1
  const out = new Float32Array(GW * GH)
  for (let gy = 0; gy < GH; gy++) {
    const y0 = c.mnY + Math.floor(gy * bh / GH)
    const y1 = Math.max(y0 + 1, c.mnY + Math.floor((gy + 1) * bh / GH))
    for (let gx = 0; gx < GW; gx++) {
      const x0 = c.mnX + Math.floor(gx * bw / GW)
      const x1 = Math.max(x0 + 1, c.mnX + Math.floor((gx + 1) * bw / GW))
      let s = 0, t = 0
      for (let y = y0; y < y1 && y <= c.mxY; y++) for (let x = x0; x < x1 && x <= c.mxX; x++) { s += mask[y * W + x]; t++ }
      out[gy * GW + gx] = t ? s / t : 0
    }
  }
  return out
}

function buildFeatures(norm, meta) {
  const f = new Float32Array(FEAT_DIM)
  f.set(norm, 0)
  let o = GW * GH
  const zw = GW / ZONES, zh = GH / ZONES
  for (let zy = 0; zy < ZONES; zy++) for (let zx = 0; zx < ZONES; zx++) {
    let s = 0, t = 0
    for (let y = Math.floor(zy * zh); y < Math.floor((zy + 1) * zh); y++)
      for (let x = Math.floor(zx * zw); x < Math.floor((zx + 1) * zw); x++) { s += norm[y * GW + x]; t++ }
    f[o++] = t ? s / t : 0
  }
  f[o++] = meta.aspect      // w/h
  f[o++] = meta.fill        // площадь / bbox
  f[o++] = meta.stroke      // средняя «толщина»
  return f
}

// пересборка компонента по подрегиону (после разреза)
function subComponent(mask, W, H, x0, x1, y0, y1) {
  let a = 0, mnX = 1e9, mxX = -1e9, mnY = 1e9, mxY = -1e9
  const px = []
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if (!mask[y * W + x]) continue
    a++; px.push(y * W + x)
    if (x < mnX) mnX = x; if (x > mxX) mxX = x
    if (y < mnY) mnY = y; if (y > mxY) mxY = y
  }
  if (!a) return null
  return { a, mnX, mxX, mnY, mxY, px }
}

// Слипшиеся цифры: если компонент заметно шире, чем одна цифра при такой высоте,
// режем его по минимуму вертикального профиля (классика segmentation).
function splitComponent(mask, W, H, c, opts) {
  const bw = c.mxX - c.mnX + 1, bh = c.mxY - c.mnY + 1
  const ratio = (opts && opts.digitRatio) || 0.62     // ширина цифры ≈ 0.62 высоты
  const est = Math.round(bw / (bh * ratio))
  if (est < 2 || bh < 8) return [c]
  const maxParts = (opts && opts.maxParts) || 5
  const n = Math.min(est, maxParts)
  const prof = new Int32Array(bw)
  for (let x = 0; x < bw; x++) { let s = 0; for (let y = c.mnY; y <= c.mxY; y++) s += mask[y * W + c.mnX + x]; prof[x] = s }
  const seg = Math.floor(bw / n)
  const cuts = []
  let start = 0
  for (let k = 1; k < n; k++) {
    const ideal = Math.round(k * bw / n)
    const lo = Math.max(start + Math.max(3, Math.floor(seg * 0.45)), ideal - Math.floor(seg * 0.35))
    const hi = Math.min(bw - Math.max(3, Math.floor(seg * 0.45)) * (n - k), ideal + Math.floor(seg * 0.35))
    let bestX = ideal, bestV = Infinity
    for (let x = lo; x <= hi; x++) {
      if (x < 1 || x >= bw - 1) continue
      const v = prof[x - 1] + prof[x] * 0.6 + prof[x + 1]
      if (v < bestV) { bestV = v; bestX = x }
    }
    cuts.push(bestX)
    start = bestX
  }
  const parts = []
  let prev = 0
  for (const cx of cuts.concat([bw])) {
    const sc = subComponent(mask, W, H, c.mnX + prev, c.mnX + cx - 1, c.mnY, c.mxY)
    if (sc) parts.push(sc)
    prev = cx
  }
  return parts.length ? parts : [c]
}


// =========================================================================
//  УМНАЯ СЕГМЕНТАЦИЯ: «ровно N цифр» вместо поиска связных компонентов
// =========================================================================
// Почему не компоненты: на map-art фон пёстрый/дитеринговый, цифры часто
// слипаются или, наоборот, рассыпаются на куски — компоненты дают то 0, то 200.
// Идея: мы ЗНАЕМ, что цифр ровно expected. Поэтому
//   1) перебираем способы получить бинарную маску «чернила/фон»
//      (доминантный цвет, Otsu по яркости, локальный фон по тайлам, каждый цвет палитры),
//   2) на маске находим полосу строк с цифрами,
//   3) режем её динамическим программированием РОВНО на expected сегментов
//      (границы — там, где меньше всего чернил, ширина близка к равномерной),
//   4) оцениваем результат («похоже на 5 цифр?») и берём лучшую стратегию.
// Слипшиеся цифры разрезаются, рассыпавшиеся — склеиваются, шум отсекается оценкой.

function histColors(data) {
  const wc = new Int32Array(256)
  for (let i = 0; i < data.length; i++) wc[data[i]]++
  return wc
}

// --- маски ---
function maskDominant(data, W, H, k) {
  const wc = histColors(data)
  const order = []
  for (let v = 0; v < 256; v++) if (wc[v]) order.push(v)
  order.sort((a, b) => wc[b] - wc[a])
  const bg = new Set(order.slice(0, Math.max(1, k)))
  const m = new Uint8Array(data.length)
  for (let i = 0; i < data.length; i++) m[i] = bg.has(data[i]) ? 0 : 1
  return m
}
function maskOtsu(data, W, H, invert) {
  const hist = new Int32Array(256)
  for (let i = 0; i < data.length; i++) hist[LUM[data[i]]]++
  const total = data.length
  let sum = 0
  for (let t = 0; t < 256; t++) sum += t * hist[t]
  let sumB = 0, wB = 0, best = -1, thr = 128
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (!wB) continue
    const wF = total - wB
    if (!wF) break
    sumB += t * hist[t]
    const mB = sumB / wB, mF = (sum - sumB) / wF
    const v = wB * wF * (mB - mF) * (mB - mF)
    if (v > best) { best = v; thr = t }
  }
  const m = new Uint8Array(data.length)
  for (let i = 0; i < data.length; i++) {
    const dark = LUM[data[i]] <= thr
    m[i] = (invert ? !dark : dark) ? 1 : 0
  }
  return m
}
function maskLocalBg(data, W, H, tile) {
  const m = new Uint8Array(data.length)
  for (let ty = 0; ty < H; ty += tile) for (let tx = 0; tx < W; tx += tile) {
    const x1 = Math.min(W, tx + tile), y1 = Math.min(H, ty + tile)
    const wc = new Int32Array(256)
    for (let y = ty; y < y1; y++) for (let x = tx; x < x1; x++) wc[data[y * W + x]]++
    let bg = 0, bc = -1
    for (let v = 0; v < 256; v++) if (wc[v] > bc) { bc = wc[v]; bg = v }
    for (let y = ty; y < y1; y++) for (let x = tx; x < x1; x++) m[y * W + x] = data[y * W + x] === bg ? 0 : 1
  }
  return m
}
function maskOneColor(data, W, H, color) {
  const m = new Uint8Array(data.length)
  for (let i = 0; i < data.length; i++) m[i] = data[i] === color ? 1 : 0
  return m
}
function maskInvert(m) { const o = new Uint8Array(m.length); for (let i = 0; i < m.length; i++) o[i] = m[i] ? 0 : 1; return o }
function maskClose(m, W, H) {   // склеить рассыпавшееся (closing 1)
  const t = new Uint8Array(m.length)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x
    if (m[i] || (x > 0 && m[i - 1]) || (x < W - 1 && m[i + 1]) || (y > 0 && m[i - W]) || (y < H - 1 && m[i + W])) t[i] = 1
  }
  const o = new Uint8Array(m.length)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x
    if (t[i] && (x === 0 || t[i - 1]) && (x === W - 1 || t[i + 1]) && (y === 0 || t[i - W]) && (y === H - 1 || t[i + W])) o[i] = 1
  }
  return o
}
function maskErode(m, W, H) {
  const o = new Uint8Array(m.length)
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x
    if (m[i] && m[i - 1] && m[i + 1] && m[i - W] && m[i + W]) o[i] = 1
  }
  return o
}
function maskDilate(m, W, H) {
  const o = new Uint8Array(m.length)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x
    if (m[i] || (x > 0 && m[i - 1]) || (x < W - 1 && m[i + 1]) || (y > 0 && m[i - W]) || (y < H - 1 && m[i + W])) o[i] = 1
  }
  return o
}
// открытие (эрозия+дилатация) убирает одиночные пиксели и дитеринг,
// оставляя толстые штрихи цифр нетронутыми
function maskOpen(m, W, H) { return maskDilate(maskErode(m, W, H), W, H) }
// маска по порогу яркости палитры (развёртка порогов сильно повышает шанс попасть в цель)
function maskLum(data, thr, below) {
  const m = new Uint8Array(data.length)
  for (let i = 0; i < data.length; i++) { const dark = LUM[data[i]] <= thr; m[i] = (below ? dark : !dark) ? 1 : 0 }
  return m
}
// 2-кластерная сегментация цветов по RGB (k-means по гистограмме палитры):
// на пёстром map-art фоне цифры часто образуют ОТДЕЛЬНЫЙ кластер, даже если
// фон состоит из десятков цветов
function maskClusters(data, k) {
  const wc = histColors(data)
  const pts = []
  for (let v = 1; v < 256; v++) if (wc[v]) pts.push({ v, w: wc[v], r: PALETTE[v * 3], g: PALETTE[v * 3 + 1], b: PALETTE[v * 3 + 2] })
  if (pts.length < 2) return null
  // инициализация: самый частый + самый удалённый от него
  const cents = []
  pts.sort((a, b) => b.w - a.w)
  cents.push([pts[0].r, pts[0].g, pts[0].b])
  while (cents.length < k) {
    let far = null, fd = -1
    for (const p of pts) {
      let dmin = 1e9
      for (const c of cents) { const d = (p.r - c[0]) ** 2 + (p.g - c[1]) ** 2 + (p.b - c[2]) ** 2; if (d < dmin) dmin = d }
      if (dmin * p.w > fd) { fd = dmin * p.w; far = p }
    }
    if (!far) break
    cents.push([far.r, far.g, far.b])
  }
  let assign = new Map()
  for (let it = 0; it < 8; it++) {
    const sum = cents.map(() => [0, 0, 0, 0])
    assign = new Map()
    for (const p of pts) {
      let bi = 0, bd = 1e18
      for (let i = 0; i < cents.length; i++) {
        const d = (p.r - cents[i][0]) ** 2 + (p.g - cents[i][1]) ** 2 + (p.b - cents[i][2]) ** 2
        if (d < bd) { bd = d; bi = i }
      }
      assign.set(p.v, bi)
      sum[bi][0] += p.r * p.w; sum[bi][1] += p.g * p.w; sum[bi][2] += p.b * p.w; sum[bi][3] += p.w
    }
    let moved = false
    for (let i = 0; i < cents.length; i++) {
      if (!sum[i][3]) continue
      const nr = sum[i][0] / sum[i][3], ng = sum[i][1] / sum[i][3], nb = sum[i][2] / sum[i][3]
      if (Math.abs(nr - cents[i][0]) + Math.abs(ng - cents[i][1]) + Math.abs(nb - cents[i][2]) > 1) moved = true
      cents[i] = [nr, ng, nb]
    }
    if (!moved) break
  }
  // размеры кластеров: «цифровой» = не самый большой
  const sizes = cents.map(() => 0)
  for (const p of pts) sizes[assign.get(p.v)] += p.w
  const out = []
  for (let c = 0; c < cents.length; c++) {
    const m = new Uint8Array(data.length)
    for (let i = 0; i < data.length; i++) m[i] = assign.get(data[i]) === c ? 1 : 0
    out.push({ mask: m, cluster: c, share: sizes[c] / data.length })
  }
  return out
}
function maskCount(m) { let n = 0; for (let i = 0; i < m.length; i++) n += m[i]; return n }

// --- полоса строк с цифрами ---
function bestBand(mask, W, H) {
  const prof = new Int32Array(H)
  for (let y = 0; y < H; y++) { let s = 0; const o = y * W; for (let x = 0; x < W; x++) s += mask[o + x]; prof[y] = s }
  const total = prof.reduce((a, b) => a + b, 0)
  if (!total) return null
  const minH = Math.max(8, Math.round(H * 0.06)), maxH = Math.round(H * 0.75)
  const pre = new Int32Array(H + 1)
  for (let y = 0; y < H; y++) pre[y + 1] = pre[y] + prof[y]
  let best = null
  for (let y0 = 0; y0 < H; y0++) {
    for (let y1 = y0 + minH; y1 <= Math.min(H, y0 + maxH); y1++) {
      const inside = pre[y1] - pre[y0]
      const h = y1 - y0
      const density = inside / (h * W)
      if (density < 0.004 || density > 0.6) continue
      const share = inside / total                       // доля всех чернил в полосе
      const tight = inside / Math.max(1, h * W)            // плотность внутри
      const score = share * 60 + Math.min(1, tight * 8) * 20 - Math.abs(h - H * 0.28) / H * 12
      if (!best || score > best.score) best = { y0, y1: y1 - 1, score, share, density, h }
    }
  }
  return best
}

// --- ДП-разрезание строки ровно на n сегментов ---
function dpSegment(mask, W, y0, y1, n) {
  const prof = new Int32Array(W)
  for (let x = 0; x < W; x++) { let s = 0; for (let y = y0; y <= y1; y++) s += mask[y * W + x]; prof[x] = s }
  const bandH = y1 - y0 + 1
  let x0 = -1, x1 = -1
  for (let x = 0; x < W; x++) if (prof[x] > 0) { if (x0 < 0) x0 = x; x1 = x }
  if (x0 < 0) return null
  const span = x1 - x0 + 1
  const ideal = span / n
  if (ideal < 4) return null
  const pre = new Int32Array(W + 1)
  for (let x = 0; x < W; x++) pre[x + 1] = pre[x] + prof[x]
  const INF = 1e18
  const dp = [], bk = []
  for (let k = 0; k <= n; k++) { dp.push(new Float64Array(W + 1).fill(INF)); bk.push(new Int32Array(W + 1).fill(-1)) }
  dp[0][x0] = 0
  for (let k = 1; k <= n; k++) {
    for (let b = x0 + k; b <= x1 + 1; b++) {
      let bestC = INF, bestA = -1
      const aMin = x0 + (k - 1), aMax = b - 1
      for (let a = Math.max(aMin, b - Math.ceil(ideal * 2.2)); a < aMax; a++) {
        if (dp[k - 1][a] >= INF) continue
        const w = b - a
        const inkInside = pre[b] - pre[a]
        if (inkInside <= 0) continue
        const boundary = prof[a] + (b <= W ? prof[b - 1] * 0 : 0)   // левая граница сегмента
        const cost = dp[k - 1][a] + boundary * 0.6 +
          Math.abs(w - ideal) / ideal * 22 +
          (w < ideal * 0.35 ? 25 : 0) + (w > ideal * 2.0 ? 25 : 0)
        if (cost < bestC) { bestC = cost; bestA = a }
      }
      if (bestA >= 0) { dp[k][b] = bestC; bk[k][b] = bestA }
    }
  }
  if (dp[n][x1 + 1] >= INF) {
    // не получилось ровно n — возвращаем равномерную нарезку как запасной вариант
    const segs = []
    for (let k = 0; k < n; k++) segs.push([Math.round(x0 + k * ideal), Math.round(x0 + (k + 1) * ideal) - 1])
    return { segs, cost: null, fallback: true, prof }
  }
  const segs = []
  let b = x1 + 1
  for (let k = n; k >= 1; k--) { const a = bk[k][b]; segs.unshift([a, b - 1]); b = a }
  return { segs, cost: dp[n][x1 + 1], fallback: false, prof }
}

function tightBoxes(mask, W, segs, y0, y1) {
  const out = []
  for (const [a, b] of segs) {
    let mnX = 1e9, mxX = -1e9, mnY = 1e9, mxY = -1e9, area = 0
    for (let y = y0; y <= y1; y++) for (let x = a; x <= b; x++) {
      if (!mask[y * W + x]) continue
      area++
      if (x < mnX) mnX = x; if (x > mxX) mxX = x
      if (y < mnY) mnY = y; if (y > mxY) mxY = y
    }
    if (area <= 0) { out.push(null); continue }
    out.push({ mnX, mxX, mnY, mxY, w: mxX - mnX + 1, h: mxY - mnY + 1, area })
  }
  return out
}

// --- оценка: похоже ли на expected цифр в ряд ---
function scoreBoxes(boxes, mask, W, H, y0, y1, expected) {
  if (!boxes || boxes.some(b => !b)) return -1e9
  const n = boxes.length
  if (n !== expected) return -1e9
  const hs = boxes.map(b => b.h).sort((a, b) => a - b)
  const ws = boxes.map(b => b.w).sort((a, b) => a - b)
  const medH = hs[Math.floor(n / 2)], medW = ws[Math.floor(n / 2)]
  if (medH < H * 0.05 || medH > H * 0.85) return -1e9
  const spread = a => (a[a.length - 1] - a[0]) / Math.max(1, a[Math.floor(a.length / 2)])
  const cx = boxes.map(b => (b.mnX + b.mxX) / 2)
  const gaps = []
  for (let i = 1; i < n; i++) gaps.push(cx[i] - cx[i - 1])
  const mg = gaps.reduce((a, b) => a + b, 0) / Math.max(1, gaps.length)
  const sg = Math.sqrt(gaps.reduce((a, b) => a + (b - mg) * (b - mg), 0) / Math.max(1, gaps.length))
  const cy = boxes.map(b => (b.mnY + b.mxY) / 2)
  const my = cy.reduce((a, b) => a + b, 0) / n
  const sy = Math.sqrt(cy.reduce((a, b) => a + (b - my) * (b - my), 0) / n)

  // ЖЁСТКИЕ ВОРОТА: ДП всегда даёт геометрически красивую нарезку, поэтому
  // без этих проверок побеждает маска-мусор (сплошные или пустые рамки).
  // Именно так получались предсказания вида «88888»: все 5 глифов одинаковые.
  const fills = boxes.map(b => b.area / (b.w * b.h))
  const medFill = fills.slice().sort((a, b) => a - b)[Math.floor(n / 2)]
  if (medFill > 0.86) return -1e9      // рамка залита целиком — это не цифра
  if (medFill < 0.045) return -1e9     // рамка почти пустая
  const inkTotal0 = maskCount(mask)
  if (inkTotal0 / (W * H) > 0.7) return -1e9   // маска «всё есть чернила» — бесполезна
  if (inkTotal0 < 40) return -1e9

  let s = 0
  s += 26 * Math.max(0, 1 - spread(hs))                 // одинаковая высота
  s += 18 * Math.max(0, 1 - spread(ws))                 // одинаковая ширина
  s += 18 * Math.max(0, 1 - sg / Math.max(1, mg))       // равномерные промежутки
  s += 12 * Math.max(0, 1 - sy / Math.max(1, medH * 0.5)) // на одной строке
  let okAspect = 0, okFill = 0, inkIn = 0
  for (const b of boxes) {
    const asp = b.w / b.h
    if (asp >= 0.2 && asp <= 1.4) okAspect++
    const f = b.area / (b.w * b.h)
    if (f >= 0.08 && f <= 0.8) okFill++
    inkIn += b.area
  }
  s += 14 * (okAspect / n) + 26 * (okFill / n)          // качество заполнения — важнее
  // штраф за «одинаковость» глифов: 5 разных цифр обязаны отличаться
  {
    let pairs = 0, diffSum = 0
    const norms = boxes.map(b => {
      let a = 0; for (let y = b.mnY; y <= b.mxY; y++) for (let x = b.mnX; x <= b.mxX; x++) a += mask[y * W + x]
      return a / Math.max(1, b.w * b.h)
    })
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { diffSum += Math.abs(norms[i] - norms[j]); pairs++ }
    const meanDiff = pairs ? diffSum / pairs : 0
    if (meanDiff < 0.004) s -= 40
  }
  const boxArea = boxes.reduce((a, b) => a + b.w * b.h, 0)
  const totalInk = maskCount(mask)
  const densIn = inkIn / Math.max(1, boxArea)
  const densOut = Math.max(0, totalInk - inkIn) / Math.max(1, H * W - boxArea)
  s += 34 * Math.min(1, Math.max(0, (densIn / Math.max(1e-6, densOut) - 1) / 3))   // контраст к фону
  // ГЛАВНЫЙ ШТРАФ: «грязная» маска (шум по всему полю) не годится, даже если
  // нарезка на 5 частей удалась — чернила должны лежать ВНУТРИ рамок цифр.
  const outsideFrac = Math.max(0, totalInk - inkIn) / (H * W)
  s -= 90 * Math.min(1, outsideFrac / 0.12)
  // и бонус за то, что маска почти целиком объясняется цифрами
  const insideShare = totalInk ? inkIn / totalInk : 0
  s += 22 * Math.max(0, insideShare - 0.5) * 2
  if (medH >= H * 0.12 && medH <= H * 0.6) s += 12
  return Math.round(s * 100) / 100
}

// построить маску по имени стратегии (нужно для «замка стиля»: не перебирать всё заново)
function buildMask(name, data, W, H) {
  const s = String(name || '')
  const plus = s.indexOf('+')
  const base = plus >= 0 ? s.slice(0, plus) : s
  const op = plus >= 0 ? s.slice(plus + 1) : ''
  let m = null
  if (/^dominant\d$/.test(base)) m = maskDominant(data, W, H, Number(base.slice(8)))
  else if (base === 'dominant1-inv') m = maskInvert(maskDominant(data, W, H, 1))
  else if (base === 'otsu-dark') m = maskOtsu(data, W, H, false)
  else if (base === 'otsu-light') m = maskOtsu(data, W, H, true)
  else if (/^localbg\d+$/.test(base)) m = maskLocalBg(data, W, H, Number(base.slice(7)))
  else if (/^color\d+$/.test(base)) m = maskOneColor(data, W, H, Number(base.slice(5)))
  else if (/^lum[<>]\d+$/.test(base)) m = maskLum(data, Number(base.slice(4)), base[3] === '<')
  else if (/^cluster\d+_\d+$/.test(base)) {
    const k = Number(base[7]), ci = Number(base.slice(9))
    const cls = maskClusters(data, k)
    if (cls && cls[ci]) m = cls[ci].mask
  }
  if (!m) return null
  if (op === 'open') m = maskOpen(m, W, H)
  else if (op === 'close') m = maskClose(m, W, H)
  return m
}

// --- полный автоподбор маски и нарезки ---
function autoSegment(data, W, H, expected, opts) {
  opts = opts || {}
  const limit = opts.limit || 46          // сколько стратегий перебрать максимум
  const results = []
  const wc = histColors(data)
  const total = data.length
  const tryMask = (name, mask, extra) => {
    if (!mask) return
    const cnt = maskCount(mask)
    const frac = cnt / total
    if (frac < 0.003 || frac > 0.75) return
    const band = bestBand(mask, W, H)
    if (!band) return
    const seg = dpSegment(mask, W, band.y0, band.y1, expected)
    if (!seg) return
    const boxes = tightBoxes(mask, W, seg.segs, band.y0, band.y1)
    const score0 = scoreBoxes(boxes, mask, W, H, band.y0, band.y1, expected)
    // РАВНОМЕРНАЯ НАРЕЗКА (dp не смог найти ровно N сегментов) — рамки ставятся
    // «на глазок» по ширине, а не по цифрам. Именно она давала «цифр=5/5» и
    // предсказания «88888»: все 5 кропов почти одинаковые. Штрафуем жёстко.
    const score = seg.fallback ? score0 - 55 : score0
    results.push({ name, mask, band, segs: seg.segs, boxes, score, score0, inkFrac: Math.round(frac * 10000) / 10000, dpCost: seg.cost, fallback: !!seg.fallback, extra: extra || null })
  }

  // 0) «замок стиля»: если прошлые раунды уже нашли рабочую маску — пробуем её первой
  if (opts.prefer) {
    const pm = buildMask(opts.prefer, data, W, H)
    if (pm) {
      tryMask(opts.prefer, pm, { preferred: true })
      if (results.length && results[0].score >= (opts.preferMin || 100)) {
        results[0].fastPath = true
        return results
      }
    }
  }

  // 1) доминантный фон (1..3 цвета) и его инверсия
  for (let k = 1; k <= 3; k++) {
    const m = maskDominant(data, W, H, k)
    tryMask('dominant' + k, m)
    if (k === 1) tryMask('dominant1-inv', maskInvert(m))
  }
  // 2) Otsu по яркости (тёмное/светлое)
  const mo = maskOtsu(data, W, H, false)
  tryMask('otsu-dark', mo)
  tryMask('otsu-light', maskInvert(mo))
  // 3) локальный фон по тайлам
  for (const tile of [64, 128]) tryMask('localbg' + tile, maskLocalBg(data, W, H, tile))
  // 3b) развёртка порога яркости (тёмные и светлые цифры на любом фоне)
  for (const thr of [40, 70, 100, 130, 160, 190]) {
    tryMask('lum<' + thr, maskLum(data, thr, true))
    tryMask('lum>' + thr, maskLum(data, thr, false))
  }
  // 3c) цветовые кластеры (пёстрый фон -> цифры отдельным кластером)
  for (const k of [2, 3]) {
    const cls = maskClusters(data, k)
    if (cls) for (const c of cls) if (c.share > 0.005 && c.share < 0.7) tryMask('cluster' + k + '_' + c.cluster, c.mask, { share: Math.round(c.share * 1000) / 1000 })
  }
  // 4) каждый цвет палитры по отдельности (цифры часто одного цвета)
  const colors = []
  for (let v = 0; v < 256; v++) if (wc[v] / total >= 0.002 && wc[v] / total <= 0.35) colors.push({ v, c: wc[v] })
  colors.sort((a, b) => b.c - a.c)
  for (const c of colors.slice(0, limit)) tryMask('color' + c.v, maskOneColor(data, W, H, c.v), { color: c.v, share: Math.round(c.c / total * 10000) / 10000 })
  // 5) морфология на лучших масках: +open убирает точечный шум, +close склеивает разрывы
  results.sort((a, b) => b.score - a.score)
  const top = results.slice(0, 4)
  for (const t of top) {
    if (t.name.indexOf('+') >= 0) continue
    tryMask(t.name + '+open', maskOpen(t.mask, W, H))
    tryMask(t.name + '+close', maskClose(t.mask, W, H))
  }
  // 6) если совсем плохо — открытие на масках отдельных цветов (шум того же цвета, что цифры)
  if (!results.length || results[0].score < 60) {
    for (const c of colors.slice(0, 6)) tryMask('color' + c.v + '+open', maskOpen(maskOneColor(data, W, H, c.v), W, H))
  }

  results.sort((a, b) => b.score - a.score)
  return results
}

// --- ОЧИСТКА маски внутри рамки цифры ---
// Рамки сегментация находит верно, но на реальной капче внутри них остаётся
// шум/дитеринг фона — и признак описывал шум вместо цифры (симптом: MLP
// train 84% / holdout 10%, предсказания вида «88888»). Чистим:
//   1) морфологическое открытие (убирает одиночные пиксели и тонкий дитеринг),
//   2) выбрасываем связные компоненты мельче порога (остаются только штрихи),
//   3) пересчитываем плотный bbox по очищенной маске.
function cleanBoxMask(mask, W, H, b, opts) {
  opts = opts || {}
  const pad = opts.pad == null ? 1 : opts.pad
  const x0 = Math.max(0, b.mnX - pad), x1 = Math.min(W - 1, b.mxX + pad)
  const y0 = Math.max(0, b.mnY - pad), y1 = Math.min(H - 1, b.mxY + pad)
  const w = x1 - x0 + 1, h = y1 - y0 + 1
  if (w < 3 || h < 3) return { mask, bbox: b, kept: 1, removed: 0, before: 0, after: 0 }
  const reg = new Uint8Array(w * h)
  let before = 0
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = mask[(y0 + y) * W + x0 + x]; reg[y * w + x] = v; if (v) before++ }
  if (!before) return { mask, bbox: b, kept: 0, removed: 0, before: 0, after: 0 }
  // 1) открытие
  let r2 = maskDilate(maskErode(reg, w, h), w, h)
  // если открытие всё стёрло (тонкие штрихи) — берём оригинал региона
  let after = 0
  for (let i = 0; i < r2.length; i++) after += r2[i]
  if (after < before * 0.25) { r2 = reg; after = before }
  // 2) убираем мелкие компоненты (шум), оставляем только крупные штрихи
  const minArea = Math.max(opts.minArea || 8, Math.round(w * h * 0.012))
  const comps = components8(r2, w, h)
  const clean = new Uint8Array(w * h)
  let kept = 0, removed = 0, keptPx = 0
  for (const c of comps) {
    if (c.a >= minArea) { for (const i of c.px) clean[i] = 1; kept++; keptPx += c.a } else removed++
  }
  if (keptPx < before * 0.1) { for (let i = 0; i < clean.length; i++) clean[i] = r2[i]; keptPx = after }
  // 3) пишем обратно в полноразмерную маску и считаем плотный bbox
  const out = new Uint8Array(W * H)
  let mnX = 1e9, mxX = -1e9, mnY = 1e9, mxY = -1e9
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!clean[y * w + x]) continue
    out[(y0 + y) * W + x0 + x] = 1
    if (x0 + x < mnX) mnX = x0 + x
    if (x0 + x > mxX) mxX = x0 + x
    if (y0 + y < mnY) mnY = y0 + y
    if (y0 + y > mxY) mxY = y0 + y
  }
  if (mxX < mnX) return { mask, bbox: b, kept: 0, removed, before, after: 0 }
  return {
    mask: out, kept, removed, before, after: keptPx,
    bbox: { mnX, mxX, mnY, mxY, w: mxX - mnX + 1, h: mxY - mnY + 1, area: keptPx }
  }
}

// --- нормализация с СОХРАНЕНИЕМ пропорций (растяжение ломает тонкие цифры) ---
function normalizeGlyphAR(mask, W, H, b) {
  const out = new Float32Array(GW * GH)
  const bw = b.mxX - b.mnX + 1, bh = b.mxY - b.mnY + 1
  const scale = Math.min((GW - 2) / bw, (GH - 2) / bh)
  const nw = Math.max(1, Math.round(bw * scale)), nh = Math.max(1, Math.round(bh * scale))
  const ox = Math.floor((GW - nw) / 2), oy = Math.floor((GH - nh) / 2)
  for (let gy = 0; gy < nh; gy++) {
    const sy0 = b.mnY + Math.floor(gy * bh / nh), sy1 = Math.max(sy0 + 1, b.mnY + Math.floor((gy + 1) * bh / nh))
    for (let gx = 0; gx < nw; gx++) {
      const sx0 = b.mnX + Math.floor(gx * bw / nw), sx1 = Math.max(sx0 + 1, b.mnX + Math.floor((gx + 1) * bw / nw))
      let s = 0, t = 0
      for (let y = sy0; y < sy1 && y <= b.mxY; y++) for (let x = sx0; x < sx1 && x <= b.mxX; x++) { s += mask[y * W + x]; t++ }
      const v = t ? s / t : 0
      // подавляем «полупрозрачный» шум: остатки дитеринга дают 0.1-0.3 и мешают k-NN
      out[(oy + gy) * GW + (ox + gx)] = Math.max(0, Math.min(1, (v - 0.25) / 0.55))
    }
  }
  return out
}

// --- извлечение ЦИФР умным способом: ровно expected штук ---
function extractDigitsSmart(data, W, H, expected, opts) {
  const all = autoSegment(data, W, H, expected, opts)
  if (!all.length) return { glyphs: [], strategies: [], strategy: null, score: -1 }
  const best = all[0]
  const glyphs = []
  const cleanInfo = []
  for (let i = 0; i < best.boxes.length; i++) {
    const b0 = best.boxes[i]
    if (!b0) continue
    // чистим маску внутри рамки и пересчитываем плотный bbox
    let b = b0, useMask = best.mask
    if (opts.clean !== false) {
      const cl = cleanBoxMask(best.mask, W, H, b0, opts)
      if (cl && cl.after > 0) { b = cl.bbox; useMask = cl.mask }
      cleanInfo.push({ raw: b0.w + 'x' + b0.h, clean: b.w + 'x' + b.h, inkBefore: cl ? cl.before : null, inkAfter: cl ? cl.after : null, noise: cl ? cl.removed : 0 })
    }
    const norm = normalizeGlyphAR(useMask, W, H, b)
    let sum = 0
    for (let k = 0; k < norm.length; k++) sum += norm[k]
    const stroke = sum / (GW * GH)
    const feat = buildFeatures(norm, { aspect: b.w / b.h, fill: b.area / (b.w * b.h), stroke })
    glyphs.push({
      bbox: { mnX: b.mnX, mnY: b.mnY, mxX: b.mxX, mxY: b.mxY, w: b.w, h: b.h },
      cx: (b.mnX + b.mxX) / 2, cy: (b.mnY + b.mxY) / 2,
      area: b.area, fill: Math.round(b.area / (b.w * b.h) * 1000) / 1000,
      aspect: Math.round(b.w / b.h * 1000) / 1000, stroke: Math.round(stroke * 1000) / 1000,
      norm, feat, mask: best.mask, W, H, index: i
    })
  }
  // ДЕГЕНЕРАЦИЯ: все кропы почти одинаковые («88888», «44444», «50000» в реальном
  // логе) — значит рамки стоят не на цифрах. Такую разметку НЕЛЬЗЯ класть в базу:
  // модель запоминает шум (симптом: train 84% / holdout 10%).
  let samePairs = 0, totPairs = 0
  for (let i = 0; i < glyphs.length; i++) {
    for (let j = i + 1; j < glyphs.length; j++) {
      totPairs++
      let d = 0
      const a = glyphs[i].norm, b = glyphs[j].norm
      for (let t = 0; t < a.length; t++) { const x = a[t] - b[t]; d += x * x }
      if (Math.sqrt(d) < 1.2) samePairs++
    }
  }
  const sameFrac = totPairs ? samePairs / totPairs : 0
  const degenerate = totPairs >= 4 && sameFrac >= 0.6
  const strokes = glyphs.map(g => g.stroke).sort((a, b) => a - b)
  const medStroke = strokes.length ? strokes[Math.floor(strokes.length / 2)] : 0
  return {
    glyphs, strategy: best.name, score: best.score, band: best.band, boxes: best.boxes,
    mask: best.mask, inkFrac: best.inkFrac, extra: best.extra, fastPath: !!best.fastPath, cleanInfo,
    tried: all.length, preferred: opts.prefer || null, fallback: !!best.fallback,
    sameFrac: Math.round(sameFrac * 100) / 100, degenerate, medStroke,
    strategies: all.slice(0, 8).map(s => ({ name: s.name, score: s.score, inkFrac: s.inkFrac, extra: s.extra, fallback: s.fallback }))
  }
}

// извлечение кандидатов-глифов из ink-маски собранной капчи
function extractGlyphs(mask, W, H, opts) {
  opts = opts || {}
  const minH = opts.minH != null ? opts.minH : Math.max(10, Math.round(H * 0.10))
  const maxH = opts.maxH != null ? opts.maxH : Math.round(H * 0.80)
  const minW = opts.minW != null ? opts.minW : Math.max(5, Math.round(W * 0.015))
  const maxW = opts.maxW != null ? opts.maxW : Math.round(W * 0.35)
  const raw = components8(mask, W, H)
  // режем слипшиеся цифры
  const comps = []
  for (const c of raw) {
    for (const p of splitComponent(mask, W, H, c, opts)) comps.push(p)
  }
  const out = []
  for (const c of comps) {
    const bw = c.mxX - c.mnX + 1, bh = c.mxY - c.mnY + 1
    const fill = c.a / (bw * bh)
    const aspect = bw / bh
    if (bh < minH || bh > maxH) continue
    if (bw < minW || bw > maxW) continue
    if (aspect < 0.12 || aspect > 3.0) continue
    if (fill < 0.06 || fill > 0.95) continue
    // отбрасываем «линии» (рамки/подчёркивания)
    if (fill < 0.25 && (bw > W * 0.6 || bh > H * 0.6)) continue
    const norm = normalizeGlyph(mask, W, H, c)
    let sum = 0
    for (let i = 0; i < norm.length; i++) sum += norm[i]
    const stroke = sum / (GW * GH)
    const feat = buildFeatures(norm, { aspect, fill, stroke })
    out.push({
      bbox: { mnX: c.mnX, mnY: c.mnY, mxX: c.mxX, mxY: c.mxY, w: bw, h: bh },
      cx: c.mnX + bw / 2, cy: c.mnY + bh / 2,
      area: c.a, fill: Math.round(fill * 1000) / 1000, aspect: Math.round(aspect * 1000) / 1000,
      stroke: Math.round(stroke * 1000) / 1000, norm, feat, mask, W, H
    })
  }
  return out
}

// «цифроподобность» кандидата — чтобы отсечь шум, если найдено больше, чем нужно
function digitScore(g, medH) {
  const asp = g.bbox.w / Math.max(1, g.bbox.h)
  let s = 0
  s -= Math.abs(g.bbox.h - medH) / Math.max(1, medH) * 2.0   // высота как у остальных цифр
  s -= Math.abs(asp - 0.55) * 1.5                            // пропорции цифры
  s -= Math.abs(g.fill - 0.35) * 1.0                         // плотность заполнения
  return s
}

// Строка цифр: горизонтальная полоса, где количество глифов ближе всего к expected.
// Если в полосе лишнее (шум) — оставляем expected самых «цифроподобных».
function dominantRow(glyphs, expected) {
  if (!glyphs.length) return []
  const hs = glyphs.map(g => g.bbox.h).sort((a, b) => a - b)
  const medH = hs[Math.floor(hs.length / 2)]
  const band = Math.max(12, medH * 0.6)
  const sorted = glyphs.slice().sort((a, b) => a.cy - b.cy)
  const rows = []
  for (let i = 0; i < sorted.length; i++) {
    const grp = sorted.filter(g => Math.abs(g.cy - sorted[i].cy) <= band)
    if (!grp.length) continue
    const key = grp.map(g => g.bbox.mnX + ':' + g.bbox.mnY).sort().join(',')
    if (rows.some(r => r.key === key)) continue
    rows.push({ key, grp })
  }
  if (!rows.length) return []
  const want = expected > 0 ? expected : Infinity
  for (const r of rows) {
    r.score = (r.grp.length === want) ? 1000
      : (r.grp.length > want ? 500 - (r.grp.length - want) * 10 : r.grp.length * 40)
  }
  rows.sort((a, b) => b.score - a.score)
  let best = rows[0].grp.slice()
  if (expected > 0 && best.length > expected) {
    best = best.sort((a, b) => digitScore(b, medH) - digitScore(a, medH)).slice(0, expected)
  }
  return best.sort((a, b) => a.cx - b.cx)
}

// ------------------------- ASCII-арт для разметки -------------------------
function asciiArt(norm, w, h) {
  w = w || GW; h = h || GH
  const RAMP = ' .:-=+*#%@'
  const lines = []
  for (let y = 0; y < h; y++) {
    let s = '|'
    for (let x = 0; x < w; x++) {
      const v = norm[y * w + x]
      s += RAMP[Math.max(0, Math.min(RAMP.length - 1, Math.round(v * (RAMP.length - 1))))]
    }
    lines.push(s + '|')
  }
  return lines.join('\n')
}

// ------------------------- база размеченных глифов -------------------------
function f32ToB64(f) { return Buffer.from(f.buffer, f.byteOffset, f.byteLength).toString('base64') }
function b64ToF32(s) {
  const b = Buffer.from(s, 'base64')
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4)
}

const FEAT_VERSION = 3   // v3: очистка маски от шума + подавление дитеринга в признаке
const MAX_PER_CLASS = 400

// ---- аугментация нормализованного глифа (20×28) ----
// Один размеченный пример превращается в ~13 — обучение идёт в разы быстрее.
function sampleNorm(norm, x, y) {
  if (x < 0 || y < 0 || x > GW - 1 || y > GH - 1) return 0
  const x0 = Math.floor(x), y0 = Math.floor(y)
  const x1 = Math.min(GW - 1, x0 + 1), y1 = Math.min(GH - 1, y0 + 1)
  const fx = x - x0, fy = y - y0
  const a = norm[y0 * GW + x0] * (1 - fx) + norm[y0 * GW + x1] * fx
  const b = norm[y1 * GW + x0] * (1 - fx) + norm[y1 * GW + x1] * fx
  return a * (1 - fy) + b * fy
}
function transformNorm(norm, dx, dy, scale, angleDeg) {
  const out = new Float32Array(GW * GH)
  const a = angleDeg * Math.PI / 180
  const ca = Math.cos(a), sa = Math.sin(a)
  const cx = GW / 2, cy = GH / 2
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
    // обратное преобразование: из целевых координат в исходные
    let sx = (x - cx - dx) / scale, sy = (y - cy - dy) / scale
    const rx = sx * ca + sy * sa, ry = -sx * sa + sy * ca
    out[y * GW + x] = sampleNorm(norm, rx + cx, ry + cy)
  }
  return out
}
function augmentNorm(norm) {
  const out = []
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) out.push({ t: transformNorm(norm, dx, dy, 1, 0), tag: 's' + dx + '_' + dy })
  for (const sc of [0.93, 1.07]) out.push({ t: transformNorm(norm, 0, 0, sc, 0), tag: 'z' + sc })
  for (const an of [-4, 4]) out.push({ t: transformNorm(norm, 0, 0, 1, an), tag: 'r' + an })
  return out
}
function normToFeatures(norm, baseMeta) {
  const zones = new Float32Array(ZONES * ZONES)
  let o = 0
  const zw = GW / ZONES, zh = GH / ZONES
  for (let zy = 0; zy < ZONES; zy++) for (let zx = 0; zx < ZONES; zx++) {
    let s = 0, t = 0
    for (let y = Math.floor(zy * zh); y < Math.floor((zy + 1) * zh); y++)
      for (let x = Math.floor(zx * zw); x < Math.floor((zx + 1) * zw); x++) { s += norm[y * GW + x]; t++ }
    zones[o++] = t ? s / t : 0
  }
  const f = new Float32Array(FEAT_DIM)
  f.set(norm, 0)
  f.set(zones, GW * GH)
  let sum = 0
  for (let i = 0; i < norm.length; i++) sum += norm[i]
  f[GW * GH + ZONES * ZONES] = baseMeta ? baseMeta.aspect : 0.5
  f[GW * GH + ZONES * ZONES + 1] = baseMeta ? baseMeta.fill : 0.4
  f[GW * GH + ZONES * ZONES + 2] = sum / (GW * GH)
  return f
}

class GlyphStore {
  constructor(dir, opts) {
    this.dir = dir
    this.file = path.join(dir, 'glyphs.jsonl')
    this.samples = []
    this.skippedVersion = 0
    this.augment = !(opts && opts.augment === false)   // digits.augment=false отключает варианты
    this.useScale = !(opts && opts.scale === false)     // digits.knnScale=false отключает нормировку измерений
    this.load()
  }
  // Аугментация НЕ плодит примеры в базе (это ломает голосование k-NN, превращая его в 1-NN),
  // а хранится в памяти у каждого примера: расстояние до примера = минимум по его вариантам.
  // В файле лежит только оригинал — варианты достраиваются детерминированно при загрузке.
  makeVariants(feat) {
    if (!this.augment) return []
    // на большой базе варианты не нужны: своих примеров уже достаточно, экономим память/время
    if (this.samples.length >= 300) return []
    try {
      const norm = feat.subarray(0, GW * GH)
      const meta = { aspect: feat[GW * GH + ZONES * ZONES], fill: feat[GW * GH + ZONES * ZONES + 1] }
      return augmentNorm(norm).map(v => normToFeatures(v.t, meta))
    } catch (e) { return [] }
  }
  load() {
    try {
      if (!fs.existsSync(this.file)) return
      const lines = fs.readFileSync(this.file, 'utf8').split('\n')
      for (const ln of lines) {
        const s = ln.trim()
        if (!s) continue
        try {
          const o = JSON.parse(s)
          if (!o || typeof o.digit !== 'number' || !o.f) continue
          if ((o.fv || 1) !== FEAT_VERSION) { this.skippedVersion++; continue }   // старая нормализация несовместима
          if (String(o.src || '').indexOf('|aug:') >= 0) { this.skippedVersion++; continue } // старые аугментации-дубли
          const feat = b64ToF32(o.f)
          if (feat.length !== FEAT_DIM) { this.skippedVersion++; continue }
          this.samples.push({ digit: o.digit, feat, variants: this.makeVariants(feat), src: o.src || '', id: o.id || '' })
        } catch (e) {}
      }
    } catch (e) {}
  }
  ensureDir() { try { fs.mkdirSync(this.dir, { recursive: true }) } catch (e) {} }
  add(digit, feat, meta) {
    const id = 'g' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36)
    const rec = { id, digit, fv: FEAT_VERSION, f: f32ToB64(feat), src: (meta && meta.src) || '', ts: new Date().toISOString() }
    this.samples.push({ digit, feat, variants: this.makeVariants(feat), src: rec.src, id })
    this.ensureDir()
    fs.appendFileSync(this.file, JSON.stringify(rec) + '\n')
    // картинка — для контроля глазами
    try {
      const d = path.join(this.dir, 'glyphs', String(digit))
      fs.mkdirSync(d, { recursive: true })
      fs.writeFileSync(path.join(d, id + '.png'), pngFromNorm(feat.subarray(0, GW * GH), 8))
    } catch (e) {}
    return id
  }
  // один ответ человека = один пример в базе; варианты добавляются в память (см. makeVariants)
  addAugmented(digit, feat, meta) {
    const id = this.add(digit, feat, meta)
    return [id]
  }
  counts() {
    const c = {}
    for (const s of this.samples) c[s.digit] = (c[s.digit] || 0) + 1
    return c
  }
  get size() { return this.samples.length }
  // k-NN + оценка уверенности.
  // conf  — доля голосов ближайших соседей (вес 1/(1+d²), чтобы дальние не размывали);
  // sep   — во сколько раз ближайший «чужой» пример дальше ближайшего «своего»
  //         (главный признак: у верно распознанной цифры sep обычно десятки);
  // trust — итоговая уверенность, которую сравниваем с порогом.
  // масштабные коэффициенты по измерениям: без них «шумные» координаты признака
  // вносят основной вклад в расстояние и k-NN сравнивает шум вместо формы
  ensureScale() {
    if (this._scaleN === this.samples.length && this._scale) return this._scale
    const n = this.samples.length
    const mean = new Float64Array(FEAT_DIM)
    for (const s of this.samples) for (let i = 0; i < FEAT_DIM; i++) mean[i] += s.feat[i]
    if (n) for (let i = 0; i < FEAT_DIM; i++) mean[i] /= n
    const sd = new Float64Array(FEAT_DIM)
    for (const s of this.samples) for (let i = 0; i < FEAT_DIM; i++) { const d = s.feat[i] - mean[i]; sd[i] += d * d }
    let sumSd = 0
    for (let i = 0; i < FEAT_DIM; i++) { sd[i] = n > 1 ? Math.sqrt(sd[i] / (n - 1)) : 1; sumSd += sd[i] }
    const avg = sumSd / FEAT_DIM
    const scale = new Float64Array(FEAT_DIM)
    for (let i = 0; i < FEAT_DIM; i++) scale[i] = 1 / Math.max(sd[i], avg * 0.25, 1e-3)
    this._scale = scale
    this._scaleN = n
    return scale
  }
  classify(feat, k) {
    if (!this.samples.length) return null
    k = Math.min(k || KNN_K, this.samples.length)
    const sc = this.useScale ? this.ensureScale() : null
    const l2 = f => {
      let d = 0
      if (sc) { for (let i = 0; i < FEAT_DIM; i++) { const t = (feat[i] - f[i]) * sc[i]; d += t * t } }
      else { for (let i = 0; i < FEAT_DIM; i++) { const t = feat[i] - f[i]; d += t * t } }
      return Math.sqrt(d)
    }
    // 1) грубый отбор по оригиналам (быстро)
    const rough = this.samples.map((s, i) => ({ i, d: l2(s.feat), digit: s.digit }))
    rough.sort((a, b) => a.d - b.d)
    const shortlist = rough.slice(0, Math.max(k * 5, 25))
    // 2) уточнение: расстояние до примера = минимум по его аугментациям
    const dists = []
    for (const r of shortlist) {
      const s = this.samples[r.i]
      let best = r.d
      if (s.variants) for (const v of s.variants) { const dv = l2(v); if (dv < best) best = dv }
      dists.push({ d: best, digit: r.digit })
    }
    dists.sort((a, b) => a.d - b.d)
    // ближайший пример каждого класса
    const nearest = {}
    for (const t of dists) if (nearest[t.digit] === undefined) nearest[t.digit] = t.d
    const rankedCls = Object.entries(nearest).map(([d, v]) => ({ digit: Number(d), d: v })).sort((a, b) => a.d - b.d)
    const bestCls = rankedCls[0]
    const secondCls = rankedCls[1] || { digit: -1, d: Infinity }
    // голосование k ближайших
    const top = dists.slice(0, k)
    const votes = {}
    let wsum = 0
    for (const t of top) { const w = 1 / (1 + t.d * t.d); votes[t.digit] = (votes[t.digit] || 0) + w; wsum += w }
    const ranked = Object.entries(votes).map(([d, w]) => ({ digit: Number(d), w })).sort((a, b) => b.w - a.w)
    const best = ranked[0]
    const second = ranked[1] || { digit: -1, w: 0 }
    const conf = wsum ? best.w / wsum : 0
    const margin = wsum ? (best.w - second.w) / wsum : 0
    const dSame = bestCls ? bestCls.d : 0
    const dOther = secondCls.d
    const sep = isFinite(dOther) ? dOther / Math.max(0.05, dSame) : 20
    const cls = this.counts()[best.digit] || 0
    const sepFactor = Math.min(1, sep / 4)
    const classFactor = 0.75 + 0.25 * Math.min(1, cls / 5)
    const trust = conf * (0.35 + 0.65 * sepFactor) * classFactor
    return {
      digit: best.digit, conf: Math.round(conf * 1000) / 1000, trust: Math.round(trust * 1000) / 1000,
      margin: Math.round(margin * 1000) / 1000, sep: Math.round(Math.min(sep, 999) * 100) / 100,
      dist: Math.round(dSame * 1000) / 1000, distOther: isFinite(dOther) ? Math.round(dOther * 1000) / 1000 : null,
      alt: second.digit >= 0 ? second.digit : null, classCount: cls, method: 'knn'
    }
  }
}

// ------------------------- очередь на разметку -------------------------
class LabelQueue {
  constructor(dir) {
    this.dir = dir
    this.file = path.join(dir, 'queue.jsonl')
    this.items = []
    this.load()
  }
  load() {
    try {
      if (!fs.existsSync(this.file)) return
      for (const ln of fs.readFileSync(this.file, 'utf8').split('\n')) {
        const s = ln.trim(); if (!s) continue
        try { this.items.push(JSON.parse(s)) } catch (e) {}
      }
    } catch (e) {}
  }
  save() {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      fs.writeFileSync(this.file, this.items.map(i => JSON.stringify(i)).join('\n') + (this.items.length ? '\n' : ''))
    } catch (e) {}
  }
  push(item) { this.items.push(item); this.dirty = true }
  remove(id) { const i = this.items.findIndex(x => x.id === id); if (i >= 0) this.items.splice(i, 1); this.dirty = true }
  get size() { return this.items.length }
  has(feat) {
    // не дублируем один и тот же глиф
    for (const it of this.items) {
      if (!it.f) continue
      const f = b64ToF32(it.f)
      let d = 0
      for (let i = 0; i < FEAT_DIM; i++) { const t = feat[i] - f[i]; d += t * t }
      if (Math.sqrt(d) < 0.35) return true
    }
    return false
  }
}

// ------------------------- MLP (чистый JS) -------------------------
class MLP {
  constructor(nIn, nHid, nOut) {
    this.nIn = nIn || FEAT_DIM; this.nHid = nHid || 20; this.nOut = nOut || 10
    this.W1 = new Float64Array(this.nIn * this.nHid)
    this.b1 = new Float64Array(this.nHid)
    this.W2 = new Float64Array(this.nHid * this.nOut)
    this.b2 = new Float64Array(this.nOut)
    this.initWeights()
  }
  initWeights() {
    const s1 = Math.sqrt(2 / this.nIn), s2 = Math.sqrt(2 / this.nHid)
    for (let i = 0; i < this.W1.length; i++) this.W1[i] = (Math.random() * 2 - 1) * s1
    for (let i = 0; i < this.W2.length; i++) this.W2[i] = (Math.random() * 2 - 1) * s2
  }
  forward(x) {
    const h = new Float64Array(this.nHid)
    for (let j = 0; j < this.nHid; j++) {
      let s = this.b1[j]
      for (let i = 0; i < this.nIn; i++) s += x[i] * this.W1[i * this.nHid + j]
      h[j] = s > 0 ? s : 0.01 * s   // LeakyReLU
    }
    const o = new Float64Array(this.nOut)
    let mx = -Infinity
    for (let k = 0; k < this.nOut; k++) {
      let s = this.b2[k]
      for (let j = 0; j < this.nHid; j++) s += h[j] * this.W2[j * this.nOut + k]
      o[k] = s; if (s > mx) mx = s
    }
    let sum = 0
    for (let k = 0; k < this.nOut; k++) { o[k] = Math.exp(o[k] - mx); sum += o[k] }
    for (let k = 0; k < this.nOut; k++) o[k] /= sum
    return { h, o }
  }
  predict(x) {
    const { o } = this.forward(x)
    let bi = 0, si = -1
    for (let k = 0; k < this.nOut; k++) if (o[k] > o[bi]) { si = bi; bi = k } else if (si < 0 || o[k] > o[si]) si = k
    return { digit: bi, conf: o[bi], alt: si >= 0 ? si : null, margin: o[bi] - (si >= 0 ? o[si] : 0), method: 'mlp' }
  }
  train(X, Y, opts) {
    opts = opts || {}
    const epochs = opts.epochs || 120, lr0 = opts.lr || 0.02, bs = opts.batch || 16
    const n = X.length
    const gW1 = new Float64Array(this.W1.length), gb1 = new Float64Array(this.b1.length)
    const gW2 = new Float64Array(this.W2.length), gb2 = new Float64Array(this.b2.length)
    const idx = [...Array(n).keys()]
    const hist = []
    for (let ep = 0; ep < epochs; ep++) {
      for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = idx[i]; idx[i] = idx[j]; idx[j] = t }
      const lr = lr0 * (1 - ep / epochs) + lr0 * 0.1
      let loss = 0
      for (let b = 0; b < n; b += bs) {
        gW1.fill(0); gb1.fill(0); gW2.fill(0); gb2.fill(0)
        const m = Math.min(bs, n - b)
        for (let s = 0; s < m; s++) {
          const x = X[idx[b + s]], y = Y[idx[b + s]]
          const { h, o } = this.forward(x)
          loss += -Math.log(Math.max(1e-9, o[y]))
          const dO = new Float64Array(this.nOut)
          for (let k = 0; k < this.nOut; k++) dO[k] = o[k] - (k === y ? 1 : 0)
          const dH = new Float64Array(this.nHid)
          for (let j = 0; j < this.nHid; j++) {
            let s2 = 0
            for (let k = 0; k < this.nOut; k++) { s2 += dO[k] * this.W2[j * this.nOut + k]; gW2[j * this.nOut + k] += dO[k] * h[j] }
            dH[j] = h[j] > 0 ? s2 : 0.01 * s2
          }
          for (let k = 0; k < this.nOut; k++) gb2[k] += dO[k]
          for (let j = 0; j < this.nHid; j++) {
            gb1[j] += dH[j]
            if (Math.abs(dH[j]) < 1e-12) continue
            for (let i = 0; i < this.nIn; i++) gW1[i * this.nHid + j] += dH[j] * x[i]
          }
        }
        const sc = lr / m
        for (let i = 0; i < this.W1.length; i++) this.W1[i] -= sc * gW1[i]
        for (let i = 0; i < this.b1.length; i++) this.b1[i] -= sc * gb1[i]
        for (let i = 0; i < this.W2.length; i++) this.W2[i] -= sc * gW2[i]
        for (let i = 0; i < this.b2.length; i++) this.b2[i] -= sc * gb2[i]
      }
      if (ep % 10 === 0 || ep === epochs - 1) hist.push({ epoch: ep, loss: Math.round(loss / n * 1000) / 1000, acc: this.accuracy(X, Y) })
    }
    return hist
  }
  accuracy(X, Y) {
    let ok = 0
    for (let i = 0; i < X.length; i++) if (this.predict(X[i]).digit === Y[i]) ok++
    return X.length ? Math.round(1000 * ok / X.length) / 10 : 0
  }
  toJSON() {
    return { v: 1, fv: FEAT_VERSION, nIn: this.nIn, nHid: this.nHid, nOut: this.nOut, trained: new Date().toISOString(),
      W1: Buffer.from(this.W1.buffer).toString('base64'), b1: Buffer.from(this.b1.buffer).toString('base64'),
      W2: Buffer.from(this.W2.buffer).toString('base64'), b2: Buffer.from(this.b2.buffer).toString('base64') }
  }
  static fromJSON(o) {
    if (!o || o.nIn !== FEAT_DIM) return null
    // модель, обученная на признаках другой версии, выдаёт уверенный бред — не грузим
    if ((o.fv || 1) !== FEAT_VERSION) return null
    const m = new MLP(o.nIn, o.nHid, o.nOut)
    const rd = (s, n) => { const b = Buffer.from(s, 'base64'); const a = new Float64Array(b.buffer, b.byteOffset, b.byteLength / 8); return a.length === n ? a : null }
    const W1 = rd(o.W1, m.W1.length), b1 = rd(o.b1, m.b1.length), W2 = rd(o.W2, m.W2.length), b2 = rd(o.b2, m.b2.length)
    if (!W1 || !b1 || !W2 || !b2) return null
    m.W1 = W1; m.b1 = b1; m.W2 = W2; m.b2 = b2
    m.trained = o.trained
    return m
  }
  static load(dir) {
    try {
      const p = path.join(dir, 'model.json')
      if (!fs.existsSync(p)) return null
      const o = JSON.parse(fs.readFileSync(p, 'utf8'))
      const m = MLP.fromJSON(o)
      if (!m && o && (o.fv || 1) !== FEAT_VERSION) {
        MLP._stale = true
        MLP._staleFv = o.fv || 1
      }
      return m
    } catch (e) { return null }
  }
  save(dir) {
    try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'model.json'), JSON.stringify(this.toJSON())) ; return true } catch (e) { return false }
  }
}

// ------------------------- итоговое распознавание -------------------------
function recognize(glyphs, store, model, opts) {
  opts = opts || {}
  const expected = Number(opts.expected) || 0
  // presorted=true — глифы уже отобраны умной сегментацией (ровно expected штук слева направо)
  const row = opts.presorted ? glyphs.slice().sort((a, b) => a.cx - b.cx) : dominantRow(glyphs, expected)
  const items = row.map((g, i) => {
    const knn = store ? store.classify(g.feat, opts.k || KNN_K) : null
    let mlp = null
    if (model) { try { mlp = model.predict(g.feat) } catch (e) {} }
    // берём тот результат, который увереннее; при равенстве — k-NN (он объяснимее)
    let pick = null
    if (knn && mlp) pick = (mlp.conf >= (knn.trust || 0)) ? mlp : knn
    else pick = knn || mlp
    return {
      idx: i, x: Math.round(g.cx), y: Math.round(g.cy), w: g.bbox.w, h: g.bbox.h,
      fill: g.fill, aspect: g.aspect,
      knn: knn ? { digit: knn.digit, conf: knn.conf, trust: knn.trust, alt: knn.alt, dist: knn.dist, n: knn.classCount } : null,
      mlp: mlp ? { digit: mlp.digit, conf: Math.round(mlp.conf * 1000) / 1000, alt: mlp.alt } : null,
      digit: pick ? pick.digit : null,
      conf: pick ? Math.round(((pick.trust != null ? pick.trust : pick.conf) || 0) * 1000) / 1000 : 0,
      method: pick ? pick.method : 'none',
      glyph: g
    }
  })
  const confOk = opts.confOk != null ? opts.confOk : CONF_OK
  const text = items.filter(it => it.conf >= confOk).map(it => String(it.digit)).join('')
  const textAll = items.map(it => it.digit === null ? '?' : (it.conf >= confOk ? String(it.digit) : String(it.digit).toLowerCase())).join('')
  // ПРЕДСКАЗАНИЕ: по одному символу на каждый из expected глифов, даже при низкой уверенности
  const prediction = items.map(it => (it.digit === null || it.digit === undefined) ? '?' : String(it.digit)).join('')
  const complete = expected > 0 ? items.length === expected : true
  const confident = items.length > 0 && items.every(it => it.conf >= confOk)
  const avgConf = items.length ? Math.round(items.reduce((s, it) => s + (it.conf || 0), 0) / items.length * 100) / 100 : 0
  const needLabel = items.filter(it => it.conf < (opts.confQueue != null ? opts.confQueue : CONF_QUEUE))
  return {
    text, textAll, prediction, complete, confident, avgConf, expected,
    items, needLabel, rowCount: row.length, allCount: glyphs.length
  }
}

function enqueueGlyphs(queue, needLabel, meta) {
  let added = 0
  for (const it of needLabel) {
    const g = it.glyph
    if (!g || !g.feat) continue
    if (queue.has(g.feat)) continue
    const id = 'q' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36)
    let png = ''
    try {
      const d = path.join(queue.dir, 'unlabeled')
      fs.mkdirSync(d, { recursive: true })
      png = path.join(d, id + '.png')
      fs.writeFileSync(png, pngFromNorm(g.feat.subarray(0, GW * GH), 8))
    } catch (e) {}
    queue.push({
      id, f: f32ToB64(g.feat), png,
      src: (meta && meta.src) || '', round: meta && meta.round, wall: meta && meta.wall,
      bbox: g.bbox, conf: it.conf, guess: it.digit, ts: new Date().toISOString()
    })
    added++
  }
  if (added) queue.save()
  return added
}

  return {
    GW, GH, ZONES, FEAT_DIM, CONF_OK, CONF_QUEUE,
    components8, splitComponent, subComponent, normalizeGlyph, buildFeatures,
    extractGlyphs, extractDigitsSmart, autoSegment, buildMask, normalizeGlyphAR, scoreBoxes, maskOpen, maskErode, maskDilate, cleanBoxMask,
    maskLum, maskClusters,
    dpSegment, tightBoxes, bestBand, maskDominant, maskOtsu, maskLocalBg, maskOneColor, maskClose, maskInvert,
    dominantRow, digitScore, asciiArt,
    pngGray, pngRgba, pngFromNorm, pngFromMask,
    GlyphStore, LabelQueue, MLP, recognize, enqueueGlyphs, f32ToB64, b64ToF32,
    augmentNorm, transformNorm, normToFeatures, sampleNorm, FEAT_VERSION, MAX_PER_CLASS
  }
})()

// ========================= ПАЛИТРА КАРТЫ MINECRAFT =========================
const BASE_COLORS = [[0,0,0],[127,178,56],[247,233,163],[199,199,199],[255,0,0],[160,160,255],[167,167,167],[0,124,0],[255,255,255],[164,168,184],[151,109,77],[112,112,112],[64,128,255],[104,83,50],[255,252,245],[216,127,51],[178,76,216],[102,153,216],[229,229,51],[127,204,25],[242,127,165],[76,76,76],[153,153,153],[76,127,153],[127,63,178],[51,76,178],[102,76,51],[102,127,51],[153,51,51],[25,25,25],[250,238,77],[92,219,213],[74,128,255],[0,217,58],[135,107,58],[112,2,2],[143,119,100],[161,83,37],[149,88,108],[114,119,139],[186,133,35],[103,117,52],[160,77,78],[57,42,35],[135,106,97],[86,91,91],[118,70,86],[74,59,91],[77,51,35],[76,83,42],[143,61,46],[37,22,16],[189,48,49],[148,63,97],[126,32,44],[22,119,121],[58,142,140],[74,117,116],[23,121,121],[90,90,90],[224,169,112],[127,106,82],[221,169,46],[156,104,66]]
// !!! ПРАВИЛЬНЫЙ ПОРЯДОК ОТТЕНКОВ (minecraft.wiki → Map item format):
//   byte & 3 : 0 → ×180/255, 1 → ×220/255, 2 → ×255/255, 3 → ×135/255
// Проверка: GRASS(127,178,56) id 4..7 = 89,125,39 / 109,153,48 / 127,178,56 / 67,94,29 ✓
const SHADE_MULT = [180, 220, 255, 135]
const AIR_RGB = [255, 255, 255]   // color id 0 = «не исследовано» → рисуем белым

const PALETTE = (() => {
  const p = new Uint8Array(256 * 3)
  for (let v = 0; v < 256; v++) {
    let r = AIR_RGB[0], g = AIR_RGB[1], b = AIR_RGB[2]
    if (v !== 0) {
      const base = BASE_COLORS[v >> 2] || [0, 0, 0]
      const m = SHADE_MULT[v & 3] / 255
      r = Math.round(base[0] * m); g = Math.round(base[1] * m); b = Math.round(base[2] * m)
    }
    p[v * 3] = r; p[v * 3 + 1] = g; p[v * 3 + 2] = b
  }
  return p
})()
const LUM = (() => {
  const l = new Uint8Array(256)
  for (let v = 0; v < 256; v++) l[v] = Math.round(0.299 * PALETTE[v * 3] + 0.587 * PALETTE[v * 3 + 1] + 0.114 * PALETTE[v * 3 + 2])
  return l
})()
// таблица «расстояний» между цветами палитры (для оценки швов)
let PAL_DIST = null
function palDist(a, b) {
  if (a === b) return 0
  if (!PAL_DIST) {
    PAL_DIST = new Uint16Array(65536)
    for (let i = 0; i < 256; i++) for (let j = i + 1; j < 256; j++) {
      const d = Math.abs(PALETTE[i * 3] - PALETTE[j * 3]) + Math.abs(PALETTE[i * 3 + 1] - PALETTE[j * 3 + 1]) + Math.abs(PALETTE[i * 3 + 2] - PALETTE[j * 3 + 2])
      PAL_DIST[i * 256 + j] = d; PAL_DIST[j * 256 + i] = d
    }
  }
  return PAL_DIST[a * 256 + b]
}

// ========================= PNG =========================
let CRC = null
function crc32(b) {
  if (!CRC) {
    CRC = []
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); CRC[n] = c >>> 0 }
  }
  let c = 0xffffffff
  for (let i = 0; i < b.length; i++) c = (c >>> 8) ^ CRC[(c ^ b[i]) & 0xff]
  return (c ^ 0xffffffff) >>> 0
}
function encodePng(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ih = Buffer.alloc(13)
  ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4) }
  const chunk = (t, d) => {
    const l = Buffer.alloc(4); l.writeUInt32BE(d.length, 0)
    const tt = Buffer.from(t, 'ascii')
    const cr = Buffer.alloc(4); cr.writeUInt32BE(crc32(Buffer.concat([tt, d])), 0)
    return Buffer.concat([l, tt, d, cr])
  }
  return Buffer.concat([sig, chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw, 6)), chunk('IEND', Buffer.alloc(0))])
}
function colorPng(data, W, H, sc) {
  const SW = W * sc, SH = H * sc
  const rgba = Buffer.alloc(SW * SH * 4)
  for (let y = 0; y < SH; y++) {
    const srow = Math.floor(y / sc) * W
    for (let x = 0; x < SW; x++) {
      const v = data[srow + Math.floor(x / sc)]
      const i = (y * SW + x) * 4
      rgba[i] = PALETTE[v * 3]; rgba[i + 1] = PALETTE[v * 3 + 1]; rgba[i + 2] = PALETTE[v * 3 + 2]; rgba[i + 3] = 255
    }
  }
  return encodePng(SW, SH, rgba)
}
function bwPng(mask, W, H, sc) {
  const SW = W * sc, SH = H * sc, rgba = Buffer.alloc(SW * SH * 4)
  for (let y = 0; y < SH; y++) {
    const srow = Math.floor(y / sc) * W
    for (let x = 0; x < SW; x++) {
      const v = mask[srow + Math.floor(x / sc)] ? 30 : 255
      const i = (y * SW + x) * 4
      rgba[i] = rgba[i + 1] = rgba[i + 2] = v; rgba[i + 3] = 255
    }
  }
  return encodePng(SW, SH, rgba)
}

// ========================= МОРФОЛОГИЯ / OCR =========================
const NB8 = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]
function erode(m, W, H) { const o = new Uint8Array(m.length); for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) { const i = y * W + x; if (m[i] && m[i - 1] && m[i + 1] && m[i - W] && m[i + W]) o[i] = 1 }; return o }
function dilate(m, W, H) { const o = new Uint8Array(m.length); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; if (m[i] || (x > 0 && m[i - 1]) || (x < W - 1 && m[i + 1]) || (y > 0 && m[i - W]) || (y < H - 1 && m[i + W])) o[i] = 1 }; return o }
function opening(m, W, H, r) { let x = m; for (let i = 0; i < r; i++) x = erode(x, W, H); for (let i = 0; i < r; i++) x = dilate(x, W, H); return x }
function closing(m, W, H, r) { let x = m; for (let i = 0; i < r; i++) x = dilate(x, W, H); for (let i = 0; i < r; i++) x = erode(x, W, H); return x }

function components(mask, W, H, wantPx) {
  const vis = new Uint8Array(mask.length), out = []
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x
    if (!mask[i] || vis[i]) continue
    const st = [x, y]; vis[i] = 1
    let a = 0, mnX = x, mxX = x, mnY = y, mxY = y, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0
    const px = wantPx ? [i] : null
    while (st.length) {
      const cy = st.pop(), cx = st.pop()
      a++; sx += cx; sy += cy; sxx += cx * cx; syy += cy * cy; sxy += cx * cy
      if (cx < mnX) mnX = cx; if (cx > mxX) mxX = cx
      if (cy < mnY) mnY = cy; if (cy > mxY) mxY = cy
      for (const nb of NB8) {
        const nx = cx + nb[0], ny = cy + nb[1]
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
        const ni = ny * W + nx
        if (mask[ni] && !vis[ni]) { vis[ni] = 1; st.push(nx, ny); if (wantPx) px.push(ni) }
      }
    }
    const mx = sx / a, my = sy / a
    const vx = sxx / a - mx * mx, vy = syy / a - my * my, vxy = sxy / a - mx * my
    const half = (vx + vy) / 2, det = vx * vy - vxy * vxy
    const disc = Math.sqrt(Math.max(0, half * half - Math.max(0, det)))
    out.push({ mnX, mxX, mnY, mxY, a, px, varMinor: Math.max(0, half - disc), cx: mx, cy: my })
  }
  return out
}
function isStraight(c, w, h) { return c.varMinor < 10 && (w + h) > 100 }

function inkMaskWall(data, W, H) {
  const total = data.length
  const wc = new Int32Array(256)
  for (let i = 0; i < total; i++) wc[data[i]]++
  const order = []
  for (let v = 0; v < 256; v++) if (wc[v]) order.push(v)
  order.sort((a, b) => wc[b] - wc[a])
  // фон = несколько самых частых цветов (не более 4 и не более 60% пикселей)
  const bg = new Set()
  let acc = 0
  for (const v of order) {
    if (bg.size >= 4 || acc >= total * 0.6) break
    if (bg.size > 0 && wc[v] < total * 0.02) break
    bg.add(v); acc += wc[v]
  }
  let ink = new Uint8Array(total), inkCount = 0
  for (let i = 0; i < total; i++) if (!bg.has(data[i])) { ink[i] = 1; inkCount++ }
  // полярность: если «чернил» больше половины — значит фон и цифры перепутаны местами
  let inverted = false
  if (inkCount > total * 0.5) {
    const inv = new Uint8Array(total)
    for (let i = 0; i < total; i++) inv[i] = ink[i] ? 0 : 1
    ink = inv; inkCount = total - inkCount; inverted = true
  }
  return { ink, inkCount, bg: [...bg], inverted }
}
function dropLines(mask, W, H) {
  const out = new Uint8Array(mask.length)
  for (const c of components(mask, W, H, true)) {
    const w = c.mxX - c.mnX + 1, h = c.mxY - c.mnY + 1
    const isLine = (w > W * 0.85 || h > H * 0.85) || (w + h > 320 && (c.a) / (w * h) < 0.12)
    if (!isLine) for (const i of c.px) out[i] = 1
  }
  return out
}

const DIGITS = { '0': [[0,1,1,1,0],[1,0,0,0,1],[1,0,0,0,1],[1,0,0,0,1],[1,0,0,0,1],[1,0,0,0,1],[0,1,1,1,0]], '1': [[0,0,1,0,0],[0,1,1,0,0],[0,0,1,0,0],[0,0,1,0,0],[0,0,1,0,0],[0,0,1,0,0],[0,1,1,1,0]], '2': [[0,1,1,1,0],[1,0,0,0,1],[0,0,0,0,1],[0,0,0,1,0],[0,0,1,0,0],[0,1,0,0,0],[1,1,1,1,1]], '3': [[0,1,1,1,0],[1,0,0,0,1],[0,0,0,0,1],[0,0,1,1,0],[0,0,0,0,1],[1,0,0,0,1],[0,1,1,1,0]], '4': [[0,0,0,1,0],[0,0,1,1,0],[0,1,0,1,0],[1,0,0,1,0],[1,1,1,1,1],[0,0,0,1,0],[0,0,0,1,0]], '5': [[1,1,1,1,1],[1,0,0,0,0],[1,1,1,1,0],[0,0,0,0,1],[0,0,0,0,1],[1,0,0,0,1],[0,1,1,1,0]], '6': [[0,1,1,1,0],[1,0,0,0,0],[1,0,0,0,0],[1,1,1,1,0],[1,0,0,0,1],[1,0,0,0,1],[0,1,1,1,0]], '7': [[1,1,1,1,1],[0,0,0,0,1],[0,0,0,1,0],[0,0,1,0,0],[0,0,1,0,0],[0,0,1,0,0],[0,0,1,0,0]], '8': [[0,1,1,1,0],[1,0,0,0,1],[1,0,0,0,1],[0,1,1,1,0],[1,0,0,0,1],[1,0,0,0,1],[0,1,1,1,0]], '9': [[0,1,1,1,0],[1,0,0,0,1],[1,0,0,0,1],[0,1,1,1,1],[0,0,0,0,1],[0,0,0,0,1],[0,1,1,1,0]] }

function matchPat(mask, W, H, bx, by, bw, bh) {
  const pat = []
  for (let py = 0; py < 7; py++) {
    const row = []
    for (let px = 0; px < 5; px++) {
      const sx = bx + Math.floor(px * bw / 5), ex = bx + Math.floor((px + 1) * bw / 5)
      const sy = by + Math.floor(py * bh / 7), ey = by + Math.floor((py + 1) * bh / 7)
      let c = 0, t = 0
      for (let y = sy; y < ey; y++) for (let x = sx; x < ex; x++) { c += mask[y * W + x]; t++ }
      row.push(t && (c / t) > 0.35 ? 1 : 0)
    }
    pat.push(row)
  }
  let bd = '?', bs = 0
  for (const d in DIGITS) { let m = 0; for (let y = 0; y < 7; y++) for (let x = 0; x < 5; x++) if (pat[y][x] === DIGITS[d][y][x]) m++; const s = m / 35; if (s > bs) { bs = s; bd = d } }
  return { best: bd, score: Math.round(bs * 100) / 100 }
}
function ocr(mask, W, H) {
  const digits = []
  for (const c of components(mask, W, H, false)) {
    const w = c.mxX - c.mnX + 1, h = c.mxY - c.mnY + 1
    if (c.a < Math.max(80, W * H / 1600)) continue
    if (w < W * 0.02 || w > W * 0.5) continue
    if (h < H * 0.07 || h > H * 0.92) continue
    if (isStraight(c, w, h)) continue
    const m = matchPat(mask, W, H, c.mnX, c.mnY, w, h)
    digits.push({ x: c.mnX, best: m.best, score: m.score })
  }
  digits.sort((a, b) => a.x - b.x)
  let text = ''
  for (const d of digits) if (d.score >= 0.5) text += d.best
  return { text, digits }
}
function buildVariants(ink, W, H) {
  return [
    { name: 'v0_raw', mask: dropLines(ink, W, H) },
    { name: 'v1_open2', mask: dropLines(opening(ink, W, H, 2), W, H) },
    { name: 'v2_open3', mask: dropLines(opening(ink, W, H, 3), W, H) },
    { name: 'v3_close1_open2', mask: dropLines(opening(closing(ink, W, H, 1), W, H, 2), W, H) }
  ]
}
function pickOcr(vars, W, H) {
  let best = { name: 'none', text: '', n: 0, plausible: false, conf: 0, score: -1 }
  for (const v of vars) {
    const r = ocr(v.mask, W, H)
    const n = r.digits.filter(d => d.score >= 0.5).length
    const plausible = n >= 3 && n <= 8
    const conf = r.digits.filter(d => d.score >= 0.65).reduce((a, d) => a + d.score, 0)
    const score = (plausible ? 1000 : 0) + conf * 100 + n * 10 - (n > 8 ? 800 : 0)
    if (score > best.score) best = { name: v.name, text: r.text, n, plausible, conf, score }
  }
  return best
}

// ========================= ГЕОМЕТРИЯ: СЕТКА СТЕНЫ =========================
function rotQ(d, q) {
  q = ((q % 4) + 4) % 4
  if (!q) return Uint8Array.from(d)
  const o = new Uint8Array(d.length)
  for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
    const v = d[y * 128 + x]
    if (q === 1) o[x * 128 + 127 - y] = v
    else if (q === 2) o[(127 - y) * 128 + (127 - x)] = v
    else o[(127 - x) * 128 + y] = v
  }
  return o
}

function clusterValues(vals, tol) {
  if (!vals || !vals.length) return []
  const sorted = vals.slice().sort((a, b) => a - b)
  const groups = [[sorted[0]]]
  for (let i = 1; i < sorted.length; i++) {
    const cur = groups[groups.length - 1]
    if (sorted[i] - cur[cur.length - 1] <= tol) cur.push(sorted[i])
    else groups.push([sorted[i]])
  }
  return groups.map(g => ({ value: g.reduce((s, x) => s + x, 0) / g.length, n: g.length }))
}
function nearestIdx(centers, v) {
  let bi = 0, bd = Infinity
  for (let i = 0; i < centers.length; i++) { const d = Math.abs(centers[i] - v); if (d < bd) { bd = d; bi = i } }
  return { idx: bi, dist: bd }
}

// максимальный разброс yaw в группе (с учётом перехода через ±PI)
function yawSpread(frames) {
  const ys = frames.map(f => f.yaw).filter(v => typeof v === 'number' && isFinite(v))
  if (ys.length < 2) return 0
  let maxGap = 0
  const sorted = ys.slice().sort((a, b) => a - b)
  for (let i = 1; i < sorted.length; i++) maxGap = Math.max(maxGap, sorted[i] - sorted[i - 1])
  const wrap = (sorted[0] + Math.PI * 2) - sorted[sorted.length - 1]
  // наибольший «пустой» сектор => все остальные лежат в дуге (2PI - maxGap)
  const largest = Math.max(maxGap, wrap)
  return Math.round((Math.PI * 2 - largest) * 1000) / 1000
}

// максимальный промежуток между соседними центрами колонок/строк сетки
function maxGridGap(centers) {
  if (!centers || centers.length < 2) return 0
  const s = centers.slice().sort((a, b) => a - b)
  let g = 0
  for (let i = 1; i < s.length; i++) g = Math.max(g, s[i] - s[i - 1])
  return Math.round(g * 1000) / 1000
}

// все плоскости-стены: x=const и z=const.
// Отбрасываем:
//  • «линии» (ряд рамок в одну строку/колонку);
//  • СКВОЗНЫЕ артефакты: если на сервере две параллельные стены капчи, рамки
//    обеих стен с одинаковым x попадают в одну «плоскость» x=const, но колонки
//    у неё рваные (промежуток в несколько блоков) и yaw рамок смотрит в
//    противоположные стороны. Именно так в v3.8.0 раунд 6 выбрал мусорную
//    «стену» 2×3 вместо настоящей 4×3.
function detectWalls(frames, minFrames) {
  const walls = []
  for (const axis of ['x', 'z']) {
    const horiz = axis === 'x' ? 'z' : 'x'
    const cl = clusterValues(frames.map(f => f[axis]), 0.45)
    for (const c of cl) {
      const members = frames.filter(f => Math.abs(f[axis] - c.value) <= 0.45)
      if (members.length < (minFrames || 4)) continue
      const hC = clusterValues(members.map(f => f[horiz]), 0.45).map(x => x.value)
      const yC = clusterValues(members.map(f => f.y), 0.45).map(x => x.value)
      if (hC.length < 2 || yC.length < 2) continue
      const gap = Math.max(maxGridGap(hC), maxGridGap(yC))
      const ys = yawSpread(members)
      const contiguous = gap <= 1.3
      // жёстко отбрасываем явные сквозные артефакты
      if (gap > 2.5) continue
      if (ys > 2.2) continue
      walls.push({
        axis, value: c.value, frames: members, tag: axis + Math.round(c.value),
        span: hC.length + '×' + yC.length, gap, contiguous, yawSpread: ys
      })
    }
  }
  walls.sort((a, b) => (b.contiguous - a.contiguous) || (b.frames.length - a.frames.length))
  return walls
}

// расстояние от точки обзора до центра стены
function wallDist(wall, view) {
  if (!view || typeof view.x !== 'number') return null
  let cx = 0, cy = 0, cz = 0
  for (const f of wall.frames) { cx += f.x; cy += f.y; cz += f.z }
  const n = wall.frames.length || 1
  cx /= n; cy /= n; cz /= n
  const dx = cx - view.x, dy = cy - (view.y + 1.6), dz = cz - view.z
  return Math.round(Math.sqrt(dx * dx + dy * dy + dz * dz) * 100) / 100
}
// минимальное число рамок, чтобы плоскость считалась стеной-кандидатом
function wallMinFrames(linkedCount) {
  return Math.max(3, Math.min(CAP.minTiles, linkedCount || 3))
}

// сетка стены: cols × rows, cells[r*cols+c] = frame|null
function buildGrid(wall) {
  const horiz = wall.axis === 'x' ? 'z' : 'x'
  const hCl = clusterValues(wall.frames.map(f => f[horiz]), 0.45)
  const yCl = clusterValues(wall.frames.map(f => f.y), 0.45)
  const cols = hCl.length, rows = yCl.length
  const hC = hCl.map(c => c.value), yC = yCl.map(c => c.value)
  const cells = new Array(cols * rows).fill(null)
  let dup = 0, far = 0
  for (const f of wall.frames) {
    const hc = nearestIdx(hC, f[horiz]), yc = nearestIdx(yC, f.y)
    if (hc.dist > 0.45 || yc.dist > 0.45) { far++; continue }
    const idx = yc.idx * cols + hc.idx
    if (cells[idx]) { dup++; if ((f.filled || 0) > (cells[idx].filled || 0)) cells[idx] = f; continue }
    cells[idx] = f
  }
  return { wall, horiz, cols, rows, cells, hCenters: hC, yCenters: yC, dup, far, total: cols * rows }
}

// направление «лево→право» по позиции наблюдателя
function viewpointHAsc(grid, view) {
  if (!view || typeof view.x !== 'number') return null
  const v = grid.wall.value
  if (grid.wall.axis === 'z') return view.z > v ? true : false    // смотрим на север → слева меньшие x
  return view.x < v ? true : false                                // смотрим на восток → слева меньшие z
}

function orientationCandidates(grid, view) {
  const det = viewpointHAsc(grid, view)
  const base = det === null ? true : det
  const list = [
    { hAsc: base, yAsc: false, tag: det === null ? 'guess' : 'view' },
    { hAsc: !base, yAsc: false, tag: 'view-mirror' },
    { hAsc: base, yAsc: true, tag: 'view-flipy' },
    { hAsc: !base, yAsc: true, tag: 'mirror-flipy' }
  ]
  const seen = new Set()
  return list.filter(o => { const k = o.hAsc + '/' + o.yAsc; if (seen.has(k)) return false; seen.add(k); return true })
}

// кандидаты на правило поворота плитки
function rotationCandidates(frames) {
  const rots = frames.map(f => Number(f.rotation) || 0)
  const hasRot = rots.some(r => r !== 0)
  const cands = []
  const add = (name, fn) => cands.push({ name, fn })
  add('meta', f => ((Number(f.rotation) || 0) % 4 + 4) % 4)                 // по метаданным, по часовой
  add('meta-ccw', f => (4 - (((Number(f.rotation) || 0) % 4 + 4) % 4)) % 4)  // против часовой
  add('half', f => (Math.floor((Number(f.rotation) || 0) / 2) % 4 + 4) % 4)  // сервер пишет шаги по 45°
  add('none', () => 0)                                                      // игнорировать поворот
  // если все rotation==0 — все кандидаты кроме 'none' идентичны, оставляем 2
  if (!hasRot) return [cands[0], cands[3]]
  return cands
}

// собрать картинку стены
function composeImage(grid, tiles, rotFn, ori) {
  const { cols, rows, cells } = grid
  const W = cols * 128, H = rows * 128
  const out = new Uint8Array(W * H)
  const used = new Map()
  let placed = 0
  for (let r = 0; r < rows; r++) {
    const srcRow = ori.yAsc ? r : rows - 1 - r
    for (let c = 0; c < cols; c++) {
      const srcCol = ori.hAsc ? c : cols - 1 - c
      const f = cells[srcRow * cols + srcCol]
      const dx = c * 128, dy = r * 128
      if (!f || !tiles.has(f.mapId)) continue
      const raw = tiles.get(f.mapId)
      const d = rotFn ? rotQ(raw, rotFn(f)) : raw
      used.set(f.mapId, (used.get(f.mapId) || 0) + 1)
      placed++
      const dst0 = dy * W + dx
      for (let y = 0; y < 128; y++) {
        const src0 = y * 128, dst = dst0 + y * W
        for (let x = 0; x < 128; x++) out[dst + x] = d[src0 + x]
      }
    }
  }
  return { data: out, W, H, placed, missing: cols * rows - placed }
}

// Стоимость шва = «насколько стык плиток хуже обычного соседства пикселей».
// Учитываем ТОЛЬКО информативные пиксели стыка: если с обеих сторон локально
// плоский фон, позиция не несёт информации и в расчёт не идёт (иначе фон
// заглушает реальные разрывы линий). Меньше = лучше, ≈0 = идеальный стык.
// Доминирующий цвет = фон. Гистограмма набора плиток НЕ зависит от раскладки
// (повороты и перестановки её не меняют), поэтому bg одинаков для всех
// кандидатов и стоимости строго сравнимы между собой.
function dominantColor(tilesArr) {
  const wc = new Int32Array(256)
  for (const t of tilesArr) { if (!t) continue; for (let i = 0; i < t.length; i++) wc[t[i]]++ }
  let bg = 0, bc = -1
  for (let v = 0; v < 256; v++) if (wc[v] > bc) { bc = wc[v]; bg = v }
  return bg
}

// Одна позиция стыка оценивается двумя составляющими:
//  • inkFrac — доля позиций, где «чернильность» слева и справа не совпала
//    (главный признак: линия должна продолжаться через границу плиток);
//  • colorScore — насколько стык «резче» обычного соседства пикселей внутри плиток.
// Итог: inkFrac*50 + colorScore. Меньше = лучше, ~0 = идеальный стык.
const INK_WEIGHT = 50

function seamStatsV(A, B, bg) {
  let seam = 0, ns = 0, inner = 0, ni = 0, mism = 0
  for (let y = 0; y < 128; y++) {
    const o = y * 128
    const a = A[o + 127], b = B[o]
    if ((a === bg) !== (b === bg)) mism++
    seam += palDist(a, b); ns++
    inner += palDist(A[o + 126], a); ni++
    inner += palDist(b, B[o + 1]); ni++
  }
  return { seam, ns, inner, ni, mism }
}
function seamStatsH(A, B, bg) {
  let seam = 0, ns = 0, inner = 0, ni = 0, mism = 0
  for (let x = 0; x < 128; x++) {
    const a = A[127 * 128 + x], b = B[x]
    if ((a === bg) !== (b === bg)) mism++
    seam += palDist(a, b); ns++
    inner += palDist(A[126 * 128 + x], a); ni++
    inner += palDist(b, B[128 + x]); ni++
  }
  return { seam, ns, inner, ni, mism }
}
function newStats() { return { seam: 0, ns: 0, inner: 0, ni: 0, mism: 0 } }
function addStats(t, s) { t.seam += s.seam; t.ns += s.ns; t.inner += s.inner; t.ni += s.ni; t.mism += s.mism }
function statsScore(acc) {
  const s = acc.ns ? acc.seam / acc.ns : 0
  const b = acc.ni ? acc.inner / acc.ni : 0
  const inkFrac = acc.ns ? acc.mism / acc.ns : 0
  return inkFrac * INK_WEIGHT + (s - b)
}

function imageSeamCost(data, W, H, cols, rows, bg) {
  const acc = newStats()
  for (let k = 1; k < cols; k++) {
    const x = k * 128
    if (x < 2 || x + 1 >= W) continue
    for (let y = 0; y < H; y++) {
      const o = y * W
      const a = data[o + x - 1], b = data[o + x]
      if ((a === bg) !== (b === bg)) acc.mism++
      acc.seam += palDist(a, b); acc.ns++
      acc.inner += palDist(data[o + x - 2], a); acc.ni++
      acc.inner += palDist(b, data[o + x + 1]); acc.ni++
    }
  }
  for (let k = 1; k < rows; k++) {
    const y = k * 128
    if (y < 2 || y + 1 >= H) continue
    for (let x = 0; x < W; x++) {
      const a = data[(y - 1) * W + x], b = data[y * W + x]
      if ((a === bg) !== (b === bg)) acc.mism++
      acc.seam += palDist(a, b); acc.ns++
      acc.inner += palDist(data[(y - 2) * W + x], a); acc.ni++
      acc.inner += palDist(b, data[(y + 1) * W + x]); acc.ni++
    }
  }
  return Math.round(statsScore(acc) * 1000) / 1000
}

// то же по отдельным плиткам и для произвольной перестановки колонок.
// ВАЖНО: rotTiles — в ЭКРАННЫХ координатах (индекс = displayRow*cols + displayCol).
function permSeamCost(rotTiles, cols, rows, colPerm, bg) {
  const acc = newStats()
  for (let r = 0; r < rows; r++) for (let k = 0; k < cols - 1; k++) {
    const A = rotTiles[r * cols + colPerm[k]], B = rotTiles[r * cols + colPerm[k + 1]]
    if (!A || !B) continue
    addStats(acc, seamStatsV(A, B, bg))
  }
  for (let k = 0; k < cols; k++) for (let r = 0; r < rows - 1; r++) {
    const A = rotTiles[r * cols + colPerm[k]], B = rotTiles[(r + 1) * cols + colPerm[k]]
    if (!A || !B) continue
    addStats(acc, seamStatsH(A, B, bg))
  }
  return statsScore(acc)
}
function perms(arr, limit) {
  if (arr.length <= 1) return [arr.slice()]
  const res = []
  const rec = (rest, acc) => {
    if (res.length >= limit) return
    if (!rest.length) { res.push(acc); return }
    for (let i = 0; i < rest.length; i++) rec(rest.slice(0, i).concat(rest.slice(i + 1)), acc.concat([rest[i]]))
  }
  rec(arr, [])
  return res
}

// собрать картинку из массива плиток в экранных координатах
function composeFromDisp(dispTiles, cols, rows) {
  const W = cols * 128, H = rows * 128
  const out = new Uint8Array(W * H)
  let placed = 0
  for (let dr = 0; dr < rows; dr++) for (let dc = 0; dc < cols; dc++) {
    const t = dispTiles[dr * cols + dc]
    if (!t) continue
    placed++
    const dst0 = dr * 128 * W + dc * 128
    for (let y = 0; y < 128; y++) { const s0 = y * 128, d0 = dst0 + y * W; for (let x = 0; x < 128; x++) out[d0 + x] = t[s0 + x] }
  }
  return { data: out, W, H, placed, missing: cols * rows - placed }
}

// цена стыка двух плиток: B стоит справа/снизу/слева/сверху от A
function pairSeam(A, B, dr, dc, bg) {
  let s
  if (dc === 1) s = seamStatsV(A, B, bg)
  else if (dc === -1) s = seamStatsV(B, A, bg)
  else if (dr === 1) s = seamStatsH(A, B, bg)
  else s = seamStatsH(B, A, bg)
  return statsScore(s)
}

// локальная цена стыков одной плитки с соседями (для подбора поворота)
function cellSeamCost(dispTiles, cols, rows, idx, T, bg) {
  const r = Math.floor(idx / cols), c = idx % cols
  let cost = 0
  if (c > 0 && dispTiles[idx - 1]) cost += pairSeam(dispTiles[idx - 1], T, 0, 1, bg)
  if (c < cols - 1 && dispTiles[idx + 1]) cost += pairSeam(T, dispTiles[idx + 1], 0, 1, bg)
  if (r > 0 && dispTiles[idx - cols]) cost += pairSeam(dispTiles[idx - cols], T, 1, 0, bg)
  if (r < rows - 1 && dispTiles[idx + cols]) cost += pairSeam(T, dispTiles[idx + cols], 1, 0, bg)
  return cost
}

// Координатный спуск по поворотам (полировка).
function optimizeRotations(dispTiles, cols, rows, passes, bg) {
  const tilesOut = dispTiles.slice()
  const applied = new Array(cols * rows).fill(0)
  let improvedAny = false
  for (let p = 0; p < (passes || 3); p++) {
    let improved = false
    for (let idx = 0; idx < tilesOut.length; idx++) {
      const cur = tilesOut[idx]
      if (!cur) continue
      let bestQ = 0, bestT = cur, bestC = cellSeamCost(tilesOut, cols, rows, idx, cur, bg)
      for (let q = 1; q < 4; q++) {
        const t = rotQ(cur, q)
        const c = cellSeamCost(tilesOut, cols, rows, idx, t, bg)
        if (c < bestC - 1e-9) { bestC = c; bestT = t; bestQ = q }
      }
      if (bestQ) { tilesOut[idx] = bestT; applied[idx] = (applied[idx] + bestQ) % 4; improved = true; improvedAny = true }
    }
    if (!improved) break
  }
  return { tiles: tilesOut, applied, improved: improvedAny }
}

// Расстановка поворотов «распространением»: фиксируем опорную плитку,
// затем BFS — каждый сосед получает поворот с минимальной ценой стыка.
// Даёт глобально согласованную картину (в отличие от жадного спуска).
function propagateRotations(dispTiles, cols, rows, seedIdx, seedQ, bg) {
  const n = cols * rows
  const out = new Array(n).fill(null)
  const q = new Array(n).fill(0)
  out[seedIdx] = rotQ(dispTiles[seedIdx], seedQ)
  q[seedIdx] = seedQ
  const seen = new Uint8Array(n); seen[seedIdx] = 1
  const queue = [seedIdx]
  while (queue.length) {
    const idx = queue.shift()
    const r = Math.floor(idx / cols), c = idx % cols
    for (const [dr, dc] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const nr = r + dr, nc = c + dc
      if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue
      const ni = nr * cols + nc
      if (seen[ni] || !dispTiles[ni]) continue
      seen[ni] = 1
      let bestQ = 0, bestC = Infinity
      for (let qq = 0; qq < 4; qq++) {
        const t = rotQ(dispTiles[ni], qq)
        const cc = pairSeam(out[idx], t, dr, dc, bg)
        if (cc < bestC) { bestC = cc; bestQ = qq }
      }
      q[ni] = bestQ
      out[ni] = rotQ(dispTiles[ni], bestQ)
      queue.push(ni)
    }
  }
  return { tiles: out, q }
}

// полный подбор поворотов: 2 опорные плитки × 4 глобальных поворота + полировка
function solveRotations(dispTiles, cols, rows, bg) {
  const present = []
  for (let i = 0; i < dispTiles.length; i++) if (dispTiles[i]) present.push(i)
  if (present.length < 2) return null
  const center = (dispTiles.length - 1) / 2
  present.sort((a, b) => Math.abs(a - center) - Math.abs(b - center))
  let best = null
  for (const seedIdx of present.slice(0, 2)) {
    for (let seedQ = 0; seedQ < 4; seedQ++) {
      const p = propagateRotations(dispTiles, cols, rows, seedIdx, seedQ, bg)
      const img = composeFromDisp(p.tiles, cols, rows)
      const cost = imageSeamCost(img.data, img.W, img.H, cols, rows, bg)
      if (!best || cost < best.cost) best = { tiles: p.tiles, q: p.q, cost, seedIdx, seedQ }
    }
  }
  if (!best) return null
  const pol = optimizeRotations(best.tiles, cols, rows, 2, bg)
  if (pol.improved) {
    const img2 = composeFromDisp(pol.tiles, cols, rows)
    const cost2 = imageSeamCost(img2.data, img2.W, img2.H, cols, rows, bg)
    if (cost2 < best.cost) {
      return { tiles: pol.tiles, q: pol.applied.map((a, i) => (a + best.q[i]) % 4), cost: cost2, seedIdx: best.seedIdx, seedQ: best.seedQ, polished: true }
    }
  }
  return best
}

// достройка пустых ячеек неиспользованными картами (в экранных координатах)
function fillHolesDisplay(dispTiles, dispFrames, cols, rows, img, tiles, bg) {
  const usedIds = new Set()
  for (const f of (dispFrames || [])) if (f && f.mapId !== null && f.mapId !== undefined) usedIds.add(f.mapId)
  const free = []
  for (const id of tiles.keys()) if (!usedIds.has(id)) free.push(id)
  const empty = []
  for (let i = 0; i < dispTiles.length; i++) if (!dispTiles[i]) empty.push(i)
  if (!free.length || !empty.length) return { filled: 0, assignments: [] }
  const W = cols * 128
  const data = img.data
  const assignments = []
  let filled = 0
  for (const idx of empty) {
    const r = Math.floor(idx / cols), c = idx % cols
    let best = null
    for (const id of free) {
      const raw = tiles.get(id)
      for (let q = 0; q < 4; q++) {
        const d = rotQ(raw, q)
        const probe = dispTiles.slice()
        probe[idx] = d
        const sc = cellSeamCost(probe, cols, rows, idx, d, bg)
        if (!best || sc < best.sc) best = { sc, id, q, d }
      }
    }
    if (!best || !isFinite(best.sc)) continue
    const dx = c * 128, dy = r * 128
    for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) data[(dy + y) * W + dx + x] = best.d[y * 128 + x]
    dispTiles[idx] = best.d
    const fi = free.indexOf(best.id)
    if (fi >= 0) free.splice(fi, 1)
    assignments.push({ row: r, col: c, mapId: best.id, rot: best.q, seam: Math.round(best.sc * 100) / 100 })
    filled++
  }
  return { filled, assignments }
}

// главный сборщик: перебирает ориентации × правила поворота, выбирает по швам
function assembleWallSmart(wall, tiles, view, opts) {
  opts = opts || {}
  const grid = buildGrid(wall)
  if (!grid.cols || !grid.rows) return null
  const framesWithData = grid.cells.filter(f => f && tiles.has(f.mapId))
  if (!framesWithData.length) return null

  const rotCands = rotationCandidates(framesWithData)
  const oriCands = orientationCandidates(grid, view)
  const rawTiles = []
  for (const f of grid.cells) if (f && tiles.has(f.mapId)) rawTiles.push(tiles.get(f.mapId))
  const bg = dominantColor(rawTiles)
  const trials = []

  for (const ori of oriCands) {
    for (const rc of rotCands) {
      const img = composeImage(grid, tiles, rc.fn, ori)
      if (!img.placed) continue
      const cost = imageSeamCost(img.data, img.W, img.H, grid.cols, grid.rows, bg)
      trials.push({ ori, rot: rc.name, img, cost })
    }
  }
  if (!trials.length) return null
  trials.forEach((t, i) => { t.order = i })
  const tol = opts.costTolerance == null ? 0.06 : opts.costTolerance
  // минимум швов = лучшее совпадение картинки (метрика может быть отрицательной — 0 ≈ идеальный стык)
  const bestCost = trials.reduce((m, t) => Math.min(m, t.cost), Infinity)
  const slack = Math.max(1.0, Math.abs(bestCost) * tol)
  // среди «почти равных» (в пределах slack) берём приоритетного кандидата:
  // view-ориентация + meta-поворот идут первыми в списке
  const near = trials.filter(t => t.cost <= bestCost + slack)
  near.sort((a, b) => a.order - b.order)
  const best = near[0]

  const { ori, rot } = best
  const rotFn = rotCands.find(r => r.name === rot).fn
  const cols = grid.cols, rows = grid.rows

  // --- раскладываем плитки в ЭКРАННЫЕ координаты (строка 0 = верх картинки) ---
  let dispTiles = new Array(cols * rows).fill(null)
  const dispFrames = new Array(cols * rows).fill(null)
  for (let dr = 0; dr < rows; dr++) {
    const srcRow = ori.yAsc ? dr : rows - 1 - dr
    for (let dc = 0; dc < cols; dc++) {
      const srcCol = ori.hAsc ? dc : cols - 1 - dc
      const f = grid.cells[srcRow * cols + srcCol]
      if (f && tiles.has(f.mapId)) {
        dispTiles[dr * cols + dc] = rotQ(tiles.get(f.mapId), rotFn(f))
        dispFrames[dr * cols + dc] = f
      }
    }
  }

  // --- порядок колонок: координаты авторитетны, перестановка только если ЯВНО лучше ---
  const identity = [...Array(cols).keys()]
  const natCost = permSeamCost(dispTiles, cols, rows, identity, bg)
  let colPerm = identity, permCost = natCost, permUsed = false
  // Перестановка — АВВАРИЙНЫЙ путь: координаты рамок есть истина.
  // Включаем поиск, только если естественный порядок явно «рваный»
  // (PERM_TRIGGER), и принимаем перестановку, только если она лучше
  // минимум вдвое и сама по себе хорошая (PERM_ACCEPT_MAX).
  const PERM_TRIGGER = opts.permTrigger == null ? 12 : opts.permTrigger
  const PERM_ACCEPT_MAX = opts.permAcceptMax == null ? 8 : opts.permAcceptMax
  // По умолчанию ВЫКЛЮЧЕНО: координаты рамок — это истина, а перестановка
  // может «улучшить» швы на удачном совпадении и испортить правильную картинку.
  // Включается capture.tryColPerms=true / --perms, если раскладка реально едет.
  const tryPerms = opts.tryPerms != null ? opts.tryPerms : TRY_COL_PERMS
  if (cols >= 3 && cols <= 6 && tryPerms && natCost > PERM_TRIGGER) {
    let bp = null
    for (const p of perms(identity, 720)) {
      const c = permSeamCost(dispTiles, cols, rows, p, bg)
      if (!bp || c < bp.c) bp = { c, p }
    }
    if (bp && bp.c < natCost * 0.5 && bp.c < PERM_ACCEPT_MAX) { colPerm = bp.p; permCost = bp.c; permUsed = true }
  }
  if (permUsed) {
    const nt = new Array(cols * rows).fill(null)
    const nf = new Array(cols * rows).fill(null)
    for (let dr = 0; dr < rows; dr++) for (let c = 0; c < cols; c++) {
      nt[dr * cols + c] = dispTiles[dr * cols + colPerm[c]]
      nf[dr * cols + c] = dispFrames[dr * cols + colPerm[c]]
    }
    dispTiles = nt
    for (let i = 0; i < nf.length; i++) dispFrames[i] = nf[i]
  }

  let img = composeFromDisp(dispTiles, cols, rows)
  const placedFromFrames = img.placed
  let costNow = imageSeamCost(img.data, img.W, img.H, cols, rows, bg)
  const seamCostFrames = costNow

  // --- швы рвутся (Rotation не пришёл / иной порядок) => доворачиваем плитки поодиночке ---
  const ROT_OPT_THRESHOLD = opts.rotOptThreshold == null ? 8 : opts.rotOptThreshold
  let rotOpt = null
  if (opts.allowRotOpt !== false && costNow > ROT_OPT_THRESHOLD && placedFromFrames >= 3) {
    const s = solveRotations(dispTiles, cols, rows, bg)
    if (s && s.cost < costNow * 0.6) {
      dispTiles = s.tiles
      img = composeFromDisp(s.tiles, cols, rows)
      rotOpt = { applied: s.q, before: costNow, after: s.cost, seedIdx: s.seedIdx, seedQ: s.seedQ, polished: !!s.polished }
      costNow = s.cost
    }
  }

  // --- достройка дырок свободными картами ---
  const holes = fillHolesDisplay(dispTiles, dispFrames, cols, rows, img, tiles, bg)
  const finalCost = imageSeamCost(img.data, img.W, img.H, cols, rows, bg)

  const layout = []
  for (let dr = 0; dr < rows; dr++) for (let c = 0; c < cols; c++) {
    const idx = dr * cols + c
    const f = dispFrames[idx]
    const hole = holes.assignments.find(a => a.row === dr && a.col === c)
    const extra = rotOpt ? rotOpt.applied[idx] : 0
    layout.push({
      row: dr, col: c,
      mapId: f ? f.mapId : (hole ? hole.mapId : null),
      rotation: f ? ((rotFn(f) + extra) % 4) : (hole ? hole.rot : null),
      rotExtra: extra || 0,
      source: f ? 'frame' : (hole ? 'hole-fill' : 'empty'),
      x: f ? f.x : null, y: f ? f.y : null, z: f ? f.z : null
    })
  }

  return {
    grid, ori, rotRule: rotOpt ? (rot + '+optimized') : rot,
    data: img.data, W: img.W, H: img.H,
    placed: placedFromFrames, missing: cols * rows - placedFromFrames - holes.filled,
    holesFilled: holes.filled, holeAssignments: holes.assignments,
    seamCost: finalCost, seamCostFrames, natSeamCost: Math.round(natCost * 1000) / 1000,
    permSeamCost: Math.round(permCost * 1000) / 1000, permUsed, colPerm, layout, rotOpt,
    trials: trials.map(t => ({ ori: t.ori.tag, hAsc: t.ori.hAsc, yAsc: t.ori.yAsc, rot: t.rot, cost: Math.round(t.cost * 1000) / 1000, chosen: t === best }))
  }
}

// оценка «похоже ли на капчу с цифрами»
function captchaLikeness(asm) {
  const im = inkMaskWall(asm.data, asm.W, asm.H)
  const vars = buildVariants(im.ink, asm.W, asm.H)
  const pick = pickOcr(vars, asm.W, asm.H)
  const density = im.inkCount / (asm.W * asm.H)
  return { inkCount: im.inkCount, density: Math.round(density * 10000) / 10000, ocr: pick, variants: vars, ink: im.ink }
}

function wallDot(wall, view) {
  if (!view || typeof view.yaw !== 'number') return null
  let cx = 0, cz = 0
  for (const f of wall.frames) { cx += f.x; cz += f.z }
  cx /= wall.frames.length; cz /= wall.frames.length
  let dx = cx - view.x, dz = cz - view.z
  const len = Math.sqrt(dx * dx + dz * dz)
  if (len < 0.001) return 0
  dx /= len; dz /= len
  return (-Math.sin(view.yaw) * dx + Math.cos(view.yaw) * dz)
}

// ========================= РАЗБОР МЕТАДАННЫХ ENTITY =========================
function toBuf(d) {
  if (Buffer.isBuffer(d)) return d
  if (d && d.type === 'Buffer' && Array.isArray(d.data)) return Buffer.from(d.data)
  if (d instanceof Uint8Array) return Buffer.from(d.buffer, d.byteOffset, d.byteLength)
  if (Array.isArray(d)) return Buffer.from(d)
  if (d && d.buffer) return Buffer.from(d.buffer, d.byteOffset || 0, d.length)
  return null
}

// универсальный поиск map_id внутри значения слота (любая версия протокола)
function findMapIdDeep(val, depth) {
  if (val == null || depth > 7) return null
  if (typeof val === 'number' || typeof val === 'string' || typeof val === 'boolean') return null
  if (Array.isArray(val)) { for (const x of val) { const r = findMapIdDeep(x, depth + 1); if (r !== null) return r } return null }
  if (typeof val !== 'object') return null
  // data components (1.20.5+): { type: 'map_id' | 'minecraft:map_id', data: N }
  const t = String(val.type != null ? val.type : (val.name != null ? val.name : '')).replace(/^minecraft:/, '')
  if ((t === 'map_id' || t === 'map') && val.data != null) {
    if (typeof val.data === 'number') return val.data
    const d2 = firstNumberDeep(val.data, 0)
    if (d2 !== null) return d2
  }
  // NBT-тег map: { map: { type:'int', value:N } } (1.17–1.20.4) либо { map: N }
  for (const k of ['map_id', 'mapId', 'map', 'MapId', 'Map']) {
    if (typeof val[k] === 'number') return val[k]
    if (val[k] && typeof val[k] === 'object') { const n = firstNumberDeep(val[k], 0); if (n !== null) return n }
  }
  // старый формат (1.13–1.20.4): { blockId, itemCount, itemDamage }
  if (typeof val.itemDamage === 'number' && (typeof val.blockId === 'number' || typeof val.itemId === 'number')) return val.itemDamage
  // NBT: { value: { map: { type:'int', value:N } } }
  if (val.value && typeof val.value === 'object') {
    const r = findMapIdDeep(val.value, depth + 1)
    if (r !== null) return r
  }
  for (const k of Object.keys(val)) {
    if (k === 'type' || k === 'name') continue
    const r = findMapIdDeep(val[k], depth + 1)
    if (r !== null) return r
  }
  return null
}

function metaEntries(meta) {
  // nmp: [{key,type,value}] ; иногда объект {8:{...}}
  if (Array.isArray(meta)) return meta.filter(e => e && typeof e === 'object')
  if (meta && typeof meta === 'object') {
    return Object.keys(meta).map(k => {
      const e = meta[k]
      if (e && typeof e === 'object' && ('value' in e)) return { key: Number(e.key != null ? e.key : k), type: e.type, value: e.value }
      return { key: Number(k), type: null, value: e }
    })
  }
  return []
}

// первое число внутри объекта (для { data: { value: N } } и подобных)
function firstNumberDeep(val, depth) {
  if (val == null || depth > 5) return null
  if (typeof val === 'number' && Number.isFinite(val)) return val
  if (typeof val !== 'object') return null
  if (Array.isArray(val)) { for (const x of val) { const r = firstNumberDeep(x, depth + 1); if (r !== null) return r } return null }
  for (const k of ['value', 'val', 'id', 'map_id', 'mapId', 'map']) if (typeof val[k] === 'number') return val[k]
  for (const k of Object.keys(val)) { const r = firstNumberDeep(val[k], depth + 1); if (r !== null) return r }
  return null
}

// Извлечение map_id + rotation из метаданных item_frame.
// Работает и с «сырым» пакетом nmp ([{key,type,value}], type — ЧИСЛО или строка),
// и с object-формой mineflayer (entity.metadata = { '8': {...slot}, '9': 0 }).
function extractFrameInfo(meta) {
  const entries = metaEntries(meta)
  if (!entries.length) return null
  let mapId = null
  const rotCands = []

  for (const e of entries) {
    const key = Number(e.key)
    const typeStr = String(e.type == null ? '' : e.type).toLowerCase()
    const v = e.value
    // ---- слот предмета: у item_frame это key 8 (1.14+) ----
    const looksLikeSlot = !!v && typeof v === 'object' && !Array.isArray(v) &&
      ('blockId' in v || 'itemId' in v || 'components' in v || 'itemDamage' in v || 'nbtData' in v || 'present' in v)
    const isSlot = /slot|item/.test(typeStr) || key === 8 || looksLikeSlot
    if (isSlot && mapId === null) {
      const m = findMapIdDeep(v, 0)
      if (m !== null) mapId = m
    }
    // ---- rotation: целое 0..7 (у item_frame это key 9) ----
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 7) rotCands.push({ key, v })
  }

  let rotation = null
  if (rotCands.length) {
    const k9 = rotCands.find(r => r.key === 9)
    const other = rotCands.find(r => r.key === 7 || r.key === 10 || r.key === 8)
    rotation = (k9 || other || rotCands[rotCands.length - 1]).v
  }
  if (mapId === null && rotation === null) return null
  return { mapId, rotation }
}

function getMapIdFromPacket(p) {
  if (!p) return null
  for (const k of ['mapId', 'itemDamage', 'map_id', 'id', 'map']) if (typeof p[k] === 'number') return p[k]
  return null
}

// =================== ОФЛАЙН: ОТВЕТЫ ЧЕЛОВЕКА + САМОТЮНИНГ СЕГМЕНТАЦИИ ===================
// ДИАГНОЗ ПО РЕАЛЬНОМУ ЛОГУ (сессия 17:38–17:46, 54 раунда):
//   «цифр=5/5» каждый раунд, разметка шла, база выросла до 270 — но
//   MLP: 84% train / 10% holdout, предсказания «88888», «44444», «50000», «33333».
//   Вывод: рамки находятся, а ВНУТРИ них не цифра (маска-стратегия не подходит
//   к настоящей капче). Признаки описывают шум → модель запоминает шум.
//   Никакое количество новых раундов это не исправит: сначала надо понять,
//   КАКАЯ стратегия даёт настоящие кропы. Делается офлайн, на уже сохранённых
//   картинках (records/roundNN_*/ORIGINAL_raw.bin) и уже известных ответах.
//
// Ответы человека теперь сохраняются в learn/answers.jsonl — это «золотая»
// разметка: 5 цифр на картинку. Старые ответы можно импортировать прямо из
// лога: node main.js --import-answers learn\telegram.log
// Тюнинг:            node main.js --autotune            (перебор ~50 стратегий)
// Тюнинг + пересбор базы: node main.js --autotune --apply
function answersFile() { return path.join(LEARN_DIR, 'answers.jsonl') }

function appendAnswer(o) {
  try {
    fs.mkdirSync(LEARN_DIR, { recursive: true })
    fs.appendFileSync(answersFile(), JSON.stringify(o) + '\n')
    return true
  } catch (e) { dbg('answers append err ' + e.message); return false }
}

function loadAnswers() {
  const out = []
  try {
    if (!fs.existsSync(answersFile())) return out
    for (const ln of fs.readFileSync(answersFile(), 'utf8').split('\n')) {
      const s = ln.trim(); if (!s) continue
      try { const o = JSON.parse(s); if (o && /^\d{3,}$/.test(String(o.answer))) out.push(o) } catch (e) {}
    }
  } catch (e) {}
  return out
}

// ---- разбор telegram.log: «17:38:59 [TG] раунд 3: ответ «40242» (update_id=785300514)» ----
function parseAnswersFromLog(text) {
  const out = []
  const seenUpdate = new Map()   // update_id -> номер сессии (ловим «призрачные» повторы)
  let session = 0
  const lines = String(text).split(/\r?\n/)
  for (const ln of lines) {
    if (/\[TG\]\s*(транспорт:|бот @)/.test(ln) && /транспорт:/.test(ln)) session++
    const tm = ln.match(/(\d{2}):(\d{2}):(\d{2})/)
    const sec = tm ? (Number(tm[1]) * 3600 + Number(tm[2]) * 60 + Number(tm[3])) : null
    const m = ln.match(/раунд\s+(\d+):\s*ответ\s*[«"](\d{3,8})[»"](?:\s*\(update_id=(\d+)\))?/)
    if (!m) continue
    const round = Number(m[1]), answer = m[2], uid = m[3] ? Number(m[3]) : null
    if (uid !== null) {
      if (seenUpdate.has(uid) && seenUpdate.get(uid) !== session) {
        out.push({ round, answer, sec, session, uid, replayed: true, skipped: 'тот же update_id уже был в сессии ' + seenUpdate.get(uid) })
        continue
      }
      seenUpdate.set(uid, session)
    }
    if (answer.length !== DIGITS_EXPECTED) { out.push({ round, answer, sec, session, uid, skipped: 'не ' + DIGITS_EXPECTED + ' цифр' }); continue }
    out.push({ round, answer, sec, session, uid })
  }
  return out
}

function importAnswersFromFile(file) {
  if (!fs.existsSync(file)) { step('❌ файл не найден: ' + file); return { ok: false, added: 0 } }
  const parsed = parseAnswersFromLog(fs.readFileSync(file, 'utf8'))
  const good = parsed.filter(p => !p.skipped)
  const bad = parsed.filter(p => p.skipped)
  const have = new Set(loadAnswers().map(a => [a.round, a.sec, a.answer, a.src || ''].join('|')))
  let added = 0
  for (const p of good) {
    const key = [p.round, p.sec, p.answer, 'log'].join('|')
    if (have.has(key)) continue
    have.add(key)
    if (appendAnswer({ round: p.round, answer: p.answer, sec: p.sec, session: p.session, uid: p.uid, src: 'log', ts: new Date().toISOString() })) added++
  }
  step('📥 импортировано ответов из лога: ' + added + ' (всего найдено ' + good.length + ', уже было ' + (good.length - added) + ')')
  if (bad.length) step('   пропущено ' + bad.length + ': ' + bad.slice(0, 6).map(b => 'раунд ' + b.round + ' «' + b.answer + '» — ' + b.skipped).join('; '))
  if (bad.some(b => b.replayed)) step('   ⚠️ среди пропущенных есть «призрачные» ответы (повтор update_id из прошлой сессии) — они отравили бы обучение, хорошо что отброшены')
  return { ok: true, added, total: loadAnswers().length }
}

// ---- картинки раундов с диска ----
function stampOfDir(name) {
  const m = String(name).match(/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}[^_]*)/)
  if (!m) return null
  const t = Date.parse(m[1].replace(/-(\d{2})-(\d{2})$/, ':$1:$2'))
  return isNaN(t) ? null : t
}

function listRoundDirs(root) {
  const out = []
  try {
    if (!fs.existsSync(root)) return out
    for (const d of fs.readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      const m = d.name.match(/^round(\d+)_a(\d+)_(.+)$/)
      if (!m) continue
      const dir = path.join(root, d.name)
      if (!fs.existsSync(path.join(dir, 'ORIGINAL_raw.bin'))) continue
      out.push({ dir, name: d.name, round: Number(m[1]), attempt: Number(m[2]), stamp: m[3], t: stampOfDir(d.name) })
    }
  } catch (e) {}
  out.sort((a, b) => (a.t || 0) - (b.t || 0) || a.name.localeCompare(b.name))
  return out
}

function loadRawImage(dir) {
  try {
    const data = fs.readFileSync(path.join(dir, 'ORIGINAL_raw.bin'))
    let W = 0, H = 0
    for (const f of ['layout.json', 'assembly_debug.json']) {
      try {
        const o = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
        const cols = o.cols || (o.grid && o.grid.cols), rows = o.rows || (o.grid && o.grid.rows)
        if (o.W && o.H) { W = o.W; H = o.H; break }
        if (cols && rows) { W = cols * 128; H = rows * 128; break }
      } catch (e) {}
    }
    if (!W || !H) {
      // подбор по объёму: капча всегда 4×3 плитки = 512×384
      for (const [w, h] of [[512, 384], [384, 512], [512, 512], [256, 384], [384, 384]]) if (w * h === data.length) { W = w; H = h; break }
    }
    if (!W || !H || W * H !== data.length) return null
    return { data: new Uint8Array(data.buffer, data.byteOffset, data.length), W, H }
  } catch (e) { return null }
}

// ---- кропы конкретной стратегии (ровно expected штук) ----
function cropsFromSegResult(res, W, H, expected) {
  if (!res || !res.boxes || res.boxes.length !== expected) return null
  const out = []
  for (const b0 of res.boxes) {
    if (!b0) return null
    let b = b0, m = res.mask
    try {
      const cl = DIG.cleanBoxMask(res.mask, W, H, b0, {})
      if (cl && cl.after > 0) { b = cl.bbox; m = cl.mask }
    } catch (e) {}
    if (!b || b.w < 3 || b.h < 5 || b.area <= 0) return null
    const norm = DIG.normalizeGlyphAR(m, W, H, b)
    let sum = 0; for (let k = 0; k < norm.length; k++) sum += norm[k]
    const stroke = sum / (DIG.GW * DIG.GH)
    out.push({
      bbox: b, norm, stroke: Math.round(stroke * 1000) / 1000,
      fill: Math.round(b.area / (b.w * b.h) * 1000) / 1000,
      feat: DIG.buildFeatures(norm, { aspect: b.w / b.h, fill: b.area / (b.w * b.h), stroke })
    })
  }
  return out
}

// ---- leave-one-IMAGE-out k-NN: честная оценка «узнаю ли я цифру по кропу» ----
function looImageAccuracy(groups, k) {
  const all = []
  groups.forEach((g, gi) => g.items.forEach(it => all.push({ gi, feat: it.feat, digit: it.digit })))
  if (all.length < 12) return null
  const D = all[0].feat.length
  const mean = new Float64Array(D)
  for (const s of all) for (let i = 0; i < D; i++) mean[i] += s.feat[i]
  for (let i = 0; i < D; i++) mean[i] /= all.length
  const sd = new Float64Array(D)
  for (const s of all) for (let i = 0; i < D; i++) { const d = s.feat[i] - mean[i]; sd[i] += d * d }
  let sumSd = 0
  for (let i = 0; i < D; i++) { sd[i] = Math.sqrt(sd[i] / Math.max(1, all.length - 1)); sumSd += sd[i] }
  const avg = sumSd / D
  const sc = new Float64Array(D)
  for (let i = 0; i < D; i++) sc[i] = 1 / Math.max(sd[i], avg * 0.25, 1e-3)
  let ok = 0
  for (let qi = 0; qi < all.length; qi++) {
    const q = all[qi]
    const ds = []
    for (let si = 0; si < all.length; si++) {
      const s = all[si]
      if (s.gi === q.gi) continue
      let d = 0
      for (let i = 0; i < D; i++) { const t = (q.feat[i] - s.feat[i]) * sc[i]; d += t * t }
      ds.push({ d, digit: s.digit })
    }
    if (!ds.length) continue
    ds.sort((a, b) => a.d - b.d)
    const votes = {}
    for (const n of ds.slice(0, Math.min(k, ds.length))) votes[n.digit] = (votes[n.digit] || 0) + 1 / (1 + n.d)
    let bd = -1, bv = null
    for (const key in votes) if (bv === null || votes[key] > bv) { bv = votes[key]; bd = Number(key) }
    if (bd === q.digit) ok++
  }
  return { acc: Math.round(1000 * ok / all.length) / 10, n: all.length, images: groups.length }
}

// сопоставление «ответ из лога» → «каталог раунда»: номер раунда + время.
// Локальное время лога и UTC в имени каталога различаются на неизвестный сдвиг,
// поэтому сдвиг оценивается по моде всех пар (самокалибровка).
function matchAnswersToDirs(answers, dirs) {
  const byRound = new Map()
  const byName = new Map()
  for (const d of dirs) {
    if (!byRound.has(d.round)) byRound.set(d.round, [])
    byRound.get(d.round).push(d)
    byName.set(d.name, d)
  }
  // 0) точное совпадение: ответы из живой сессии знают имя каталога
  const exact = [], rest = []
  const usedExact = new Set()
  for (const a of answers) {
    const d = a.dir ? byName.get(a.dir) : null
    if (d && !usedExact.has(d.dir)) { usedExact.add(d.dir); exact.push({ answer: a, dir: d }) }
    else rest.push(a)
  }
  const pairs = []
  for (const a of rest) {
    const cands = byRound.get(Number(a.round)) || []
    for (const d of cands) {
      let delta = null
      if (a.ts) { const at = Date.parse(a.ts); if (!isNaN(at) && d.t) delta = (d.t - at) / 1000 }
      else if (a.sec !== null && a.sec !== undefined && d.t) {
        const dt = new Date(d.t)
        delta = (dt.getUTCHours() * 3600 + dt.getUTCMinutes() * 60 + dt.getUTCSeconds()) - a.sec
        if (delta > 43200) delta -= 86400
        if (delta < -43200) delta += 86400
      }
      if (delta === null) continue
      pairs.push({ a, d, delta })
    }
  }
  let offset = 0
  if (pairs.length) {
    const hist = new Map()
    for (const p of pairs) { const b = Math.round(p.delta / 900) * 900; hist.set(b, (hist.get(b) || 0) + 1) }
    let best = null, bn = -1
    for (const [b, n] of hist) if (n > bn) { bn = n; best = b }
    offset = best || 0
  }
  const usedDir = new Set(exact.map(e => e.dir.dir)), out = exact.slice()
  const near = pairs.filter(p => Math.abs(p.delta - offset) <= 1800).sort((x, y) => Math.abs(x.delta - offset) - Math.abs(y.delta - offset))
  for (const p of near) {
    if (usedDir.has(p.d.dir)) continue
    usedDir.add(p.d.dir)
    out.push({ answer: p.a, dir: p.d })
  }
  // если время сопоставить не удалось (нет ни ts, ни sec) — берём по номеру раунда
  if (out.length === exact.length) {
    for (const a of rest) {
      const cands = (byRound.get(Number(a.round)) || []).filter(d => !usedDir.has(d.dir))
      if (!cands.length) continue
      usedDir.add(cands[0].dir)
      out.push({ answer: a, dir: cands[0] })
    }
  }
  return { matched: out, offsetSec: offset, exact: exact.length, byTime: out.length - exact.length }
}

// картинка-контакт лист: строки = картинки, столбцы = 5 кропов стратегии
function contactSheetPng(rowsOfCrops) {
  try {
    const rows = (rowsOfCrops || []).filter(r => r && r.length)
    if (!rows.length) return null
    const cw = DIG.GW * 3 + 6, ch = DIG.GH * 3 + 6
    const W = Math.max.apply(null, rows.map(r => r.length)) * cw + 6, H = rows.length * ch + 6
    return DIG.pngRgba(W, H, 1, (x, y) => {
      const ri = Math.floor((y - 3) / ch), ci = Math.floor((x - 3) / cw)
      if (ri < 0 || ri >= rows.length) return [255, 255, 255]
      const c = rows[ri][ci]
      if (!c) return [255, 255, 255]
      const gx = Math.floor(((x - 3) % cw - 1) / 3), gy = Math.floor(((y - 3) % ch - 1) / 3)
      if (gx < 0 || gy < 0 || gx >= DIG.GW || gy >= DIG.GH) return [235, 235, 235]
      const v = Math.max(0, Math.min(1, Number(c.norm[gy * DIG.GW + gx]) || 0))
      const g = Math.round(255 * (1 - v))
      return [g, g, g]
    })
  } catch (e) { return null }
}

// ASCII-превью кропов — можно скопировать ПРЯМО В ЧАТ (не нужен файл)
function asciiRow(crops) {
  if (!crops || !crops.length) return '(нет)'
  const lines = []
  for (let y = 0; y < DIG.GH; y++) {
    let s = '|'
    for (const c of crops) {
      const row = DIG.asciiArt(c.norm, DIG.GW, DIG.GH).split('\n')[y] || ''
      s += row.replace(/^\||\|$/g, '') + '|'
    }
    lines.push(s)
  }
  return lines.join('\n')
}

async function runAutotune(rootDir, opts) {
  opts = opts || {}
  const root = rootDir && typeof rootDir === 'string' ? rootDir : (REC_ROOT || path.join(__dirname, 'records'))
  step('🔧 АВТОТЮНИНГ СЕГМЕНТАЦИИ (офлайн) | каталог: ' + root)
  const dirs = listRoundDirs(root)
  if (!dirs.length) {
    step('❌ в ' + root + ' нет каталогов roundNN_aN_* с ORIGINAL_raw.bin — нечего настраивать.')
    step('   Сначала соберите раунды: node main.js (или node main.js --rounds 10)')
    return { ok: false, reason: 'no dirs' }
  }
  const answers = loadAnswers()
  if (!answers.length) {
    step('❌ нет ни одного ответа человека (learn/answers.jsonl пуст).')
    step('   Импортируйте из лога:  node main.js --import-answers learn\\telegram.log')
    step('   (в логе нужны строки «раунд N: ответ «12345»»)')
    return { ok: false, reason: 'no answers', dirs: dirs.length }
  }
  const mt = matchAnswersToDirs(answers, dirs)
  step('📚 ответов в базе: ' + answers.length + ' | картинок раундов: ' + dirs.length + ' | сопоставлено: ' + mt.matched.length +
    (mt.matched.length ? ' (по имени каталога: ' + (mt.exact || 0) + ', по времени: ' + (mt.byTime || 0) +
      (mt.byTime ? ', сдвиг времени ' + Math.round(mt.offsetSec / 60) + ' мин' : '') + ')' : ''))
  if (mt.matched.length < 4) {
    step('❌ сопоставлено меньше 4 пар «картинка+ответ» — тюнинг невозможен.')
    step('   Проверьте, что ответы импортированы из того же прогона, что и каталоги records/.')
    return { ok: false, reason: 'too few pairs', pairs: mt.matched.length }
  }

  // ---- собираем кропы ВСЕХ стратегий для каждой картинки ----
  const pairs = mt.matched.slice(0, opts.maxImages || 120)
  const perStrategy = new Map()   // name -> [{items:[{feat,digit}], key}]
  const images = []
  let t0 = Date.now()
  for (const p of pairs) {
    const img = loadRawImage(p.dir.dir)
    if (!img) { step('   ⚠️ не прочитался ORIGINAL_raw.bin: ' + p.dir.name); continue }
    const digits = String(p.answer.answer)
    if (digits.length !== DIGITS_EXPECTED) continue
    let all = []
    try { all = DIG.autoSegment(img.data, img.W, img.H, DIGITS_EXPECTED, {}) || [] } catch (e) { step('   autoSegment err: ' + e.message); continue }
    if (!all.length) { step('   ⚠️ ни одна стратегия не дала ' + DIGITS_EXPECTED + ' рамок: ' + p.dir.name); continue }
    images.push({ name: p.dir.name, digits, W: img.W, H: img.H, data: img.data, results: all })
    for (const res of all) {
      const crops = cropsFromSegResult(res, img.W, img.H, DIGITS_EXPECTED)
      if (!crops) continue
      if (!perStrategy.has(res.name)) perStrategy.set(res.name, [])
      perStrategy.get(res.name).push({
        key: p.dir.name, digits,
        items: crops.map((c, i) => ({ feat: c.feat, digit: Number(digits[i]), norm: c.norm, bbox: c.bbox, stroke: c.stroke, fill: c.fill })),
        score: res.score, fallback: !!res.fallback, inkFrac: res.inkFrac
      })
    }
  }
  if (!images.length) { step('❌ не удалось извлечь кропы ни с одной картинки'); return { ok: false, reason: 'no crops' } }
  step('🖼 картинок обработано: ' + images.length + ' | стратегий-кандидатов: ' + perStrategy.size + ' (' + ((Date.now() - t0) / 1000).toFixed(1) + 'с)')

  // ---- оценка каждой стратегии: LOO k-NN + «сколько раз её выбрал бы автоподбор» ----
  const pickCount = new Map()
  for (const im of images) {
    const best = im.results.slice().sort((a, b) => b.score - a.score)[0]
    if (best) pickCount.set(best.name, (pickCount.get(best.name) || 0) + 1)
  }
  const rows = []
  t0 = Date.now()
  for (const [name, groups] of perStrategy) {
    if (groups.length < Math.max(4, Math.floor(images.length * 0.5))) continue
    let bestAcc = null
    for (const k of [1, 3, 5]) {
      const r = looImageAccuracy(groups, k)
      if (r && (!bestAcc || r.acc > bestAcc.acc)) bestAcc = Object.assign({ k }, r)
    }
    if (!bestAcc) continue
    const strokes = []
    const fills = []
    for (const g of groups) for (const it of g.items) { strokes.push(it.stroke); fills.push(it.fill) }
    strokes.sort((a, b) => a - b); fills.sort((a, b) => a - b)
    const med = a => a.length ? a[Math.floor(a.length / 2)] : 0
    // «одинаковость» кропов внутри картинки — главный симптом мусорной маски
    let samePairs = 0, totPairs = 0
    for (const g of groups) {
      for (let i = 0; i < g.items.length; i++) for (let j = i + 1; j < g.items.length; j++) {
        totPairs++
        let d = 0
        for (let t = 0; t < DIG.GW * DIG.GH; t++) { const x = g.items[i].norm[t] - g.items[j].norm[t]; d += x * x }
        if (Math.sqrt(d) < 1.2) samePairs++
      }
    }
    rows.push({
      strategy: name, acc: bestAcc.acc, k: bestAcc.k, images: groups.length,
      avgScore: Math.round(groups.reduce((a, g) => a + (g.score || 0), 0) / groups.length * 10) / 10,
      pickedByAuto: pickCount.get(name) || 0,
      medStroke: med(strokes), medFill: med(fills),
      sameFrac: totPairs ? Math.round(100 * samePairs / totPairs) : 0,
      groups
    })
  }
  rows.sort((a, b) => b.acc - a.acc || b.images - a.images)
  step('⏱ оценка стратегий: ' + ((Date.now() - t0) / 1000).toFixed(1) + 'с')
  if (!rows.length) { step('❌ ни одна стратегия не набрала достаточно картинок'); return { ok: false, reason: 'no rows' } }

  const current = readStyle()
  console.log('')
  console.log('=== ТОП-15 СТРАТЕГИЙ МАСКИ (точность = leave-one-image-out k-NN на ВАШИХ ответах) ===')
  console.log('  точн%  k  картинок  балл  выбиралась авто  одинак.кропы  штрих  заполн  стратегия')
  for (const r of rows.slice(0, 15)) {
    console.log('  ' + String(r.acc).padStart(5) + '  ' + String(r.k).padStart(1) + '  ' + String(r.images).padStart(8) +
      '  ' + String(r.avgScore).padStart(5) + '  ' + String(r.pickedByAuto).padStart(13) +
      '  ' + String(r.sameFrac + '%').padStart(11) + '  ' + String(r.medStroke).padStart(6) + '  ' + String(r.medFill).padStart(7) +
      '   ' + r.strategy + (current && current.strategy === r.strategy ? '   ← ЗАМОК СТИЛЯ (текущая)' : ''))
  }
  const best = rows[0]
  const autoPick = rows.slice().sort((a, b) => b.pickedByAuto - a.pickedByAuto)[0]
  console.log('')
  console.log('🏆 ЛУЧШАЯ: ' + best.strategy + ' → ' + best.acc + '% (k=' + best.k + ', картинок ' + best.images + ')')
  console.log('   Автоподбор сейчас чаще всего выбирает: ' + (autoPick ? autoPick.strategy + ' → ' + autoPick.acc + '%' : '—'))
  if (best.acc < 40) {
    console.log('⚠️ Даже лучшая стратегия даёт ' + best.acc + '% — похоже, проблема НЕ в маске,')
    console.log('   а в сборке картинки (плитки сложены неверно) или цифры не того цвета/контраста.')
    console.log('   Пришлите мне learn/autotune_report.json и ASCII-превью ниже.')
  } else if (best.acc >= 70) {
    console.log('✅ ' + best.acc + '% — на этой маске обучение будет работать. Зафиксируйте: --autotune --apply')
  }

  // ---- контактные листы (глазами проверить, что в кропах действительно цифры) ----
  try {
    for (const r of rows.slice(0, 3)) {
      const png = contactSheetPng(r.groups.slice(0, 12).map(g => g.items))
      if (png) {
        const f = path.join(LEARN_DIR, 'autotune_sheet_' + r.strategy.replace(/[^a-z0-9_.+-]/gi, '_') + '.png')
        fs.writeFileSync(f, png)
        step('🖼 контактный лист «' + r.strategy + '» (' + r.acc + '%): ' + f)
      }
    }
  } catch (e) { dbg('sheet err ' + e.message) }

  // ---- ASCII-превью кропов лучшей и текущей стратегии (можно скопировать в чат) ----
  const showFor = [best.strategy]
  if (current && current.strategy && current.strategy !== best.strategy) showFor.push(current.strategy)
  if (autoPick && autoPick.strategy && showFor.indexOf(autoPick.strategy) < 0) showFor.push(autoPick.strategy)
  const preview = {}
  for (const name of showFor.slice(0, 3)) {
    const row = rows.find(r => r.strategy === name)
    if (!row) continue
    const sample = row.groups.slice(0, 3)
    console.log('')
    console.log('--- КРОПЫ стратегии «' + name + '» (' + row.acc + '%), слева направо 5 цифр; подпись = правильный ответ ---')
    for (const g of sample) {
      console.log('[' + g.key + '] верно: ' + g.digits)
      console.log(asciiRow(g.items))
    }
    preview[name] = sample.map(g => ({ dir: g.key, digits: g.digits, ascii: asciiRow(g.items) }))
  }

  // ---- отчёт + фиксация стиля ----
  try {
    fs.mkdirSync(LEARN_DIR, { recursive: true })
    const report = {
      generated: new Date().toISOString(), root, images: images.length, pairs: mt.matched.length,
      offsetSec: mt.offsetSec, best: { strategy: best.strategy, acc: best.acc, k: best.k },
      autoPick: autoPick ? { strategy: autoPick.strategy, acc: autoPick.acc, pickedByAuto: autoPick.pickedByAuto } : null,
      currentStyle: current ? current.strategy : null,
      table: rows.slice(0, 30).map(r => ({ strategy: r.strategy, acc: r.acc, k: r.k, images: r.images, avgScore: r.avgScore, pickedByAuto: r.pickedByAuto, sameFrac: r.sameFrac, medStroke: r.medStroke, medFill: r.medFill })),
      preview
    }
    fs.writeFileSync(path.join(LEARN_DIR, 'autotune_report.json'), JSON.stringify(report, null, 2))
    step('📄 отчёт: ' + path.join(LEARN_DIR, 'autotune_report.json'))
  } catch (e) { step('отчёт не записан: ' + e.message) }

  if (opts.apply) {
    // 1) замок стиля на лучшую стратегию
    try {
      fs.mkdirSync(LEARN_DIR, { recursive: true })
      fs.writeFileSync(path.join(LEARN_DIR, 'style.json'), JSON.stringify({
        strategy: best.strategy, score: best.avgScore, extra: { source: 'autotune', acc: best.acc, k: best.k },
        rounds: 0, sameAsBefore: current && current.strategy === best.strategy,
        locked: true, updated: new Date().toISOString()
      }, null, 2))
      step('🔒 learn/style.json → стратегия «' + best.strategy + '» (замок, точность ' + best.acc + '%)')
    } catch (e) { step('style.json не записан: ' + e.message) }
    // 2) пересбор базы цифр из тех же картинок (мгновенно, без сервера)
    try {
      const gf = path.join(LEARN_DIR, 'glyphs.jsonl')
      if (fs.existsSync(gf)) fs.copyFileSync(gf, gf + '.bak_' + Date.now())
      const store = new DIG.GlyphStore(LEARN_DIR, { augment: DIG_AUGMENT })
      store.samples = []
      try { fs.writeFileSync(gf, '') } catch (e) {}
      let n = 0
      for (const g of best.groups) for (const it of g.items) {
        try { store.add(it.digit, it.feat, { src: 'autotune:' + g.key, aspect: it.bbox.w / Math.max(1, it.bbox.h) }); n++ } catch (e) {}
      }
      step('📚 база пересобрана лучшей стратегией: ' + n + ' примеров (старая сохранена в glyphs.jsonl.bak_*)')
      const tr = trainModel(store)
      if (tr.ok) step('🧠 MLP: ' + tr.accTrain + '% train / ' + tr.accTest + '% holdout (' + tr.samples + ' примеров) — ожидаемо ≈' + best.acc + '%')
      else step('🧠 MLP не обучена: ' + tr.reason)
    } catch (e) { step('пересбор базы не удался: ' + e.message) }
  } else {
    step('ℹ️ ничего не менял. Чтобы применить лучшую стратегию: node main.js --autotune --apply')
  }
  return { ok: true, best: best.strategy, acc: best.acc, images: images.length, rows: rows.slice(0, 15) }
}

// ---- ДИАГНОСТИКА ОДНОЙ КАРТИНКИ: что именно режет сегментация ----
// node main.js --diag              → самый свежий раунд в records/
// node main.js --diag records\round07_a1_...   → конкретный каталог
function runDiag(target) {
  const root = REC_ROOT || path.join(__dirname, 'records')
  let dir = null
  if (target && fs.existsSync(target)) dir = fs.statSync(target).isDirectory() ? target : path.dirname(target)
  if (!dir) {
    const dirs = listRoundDirs(root)
    if (!dirs.length) { step('❌ в ' + root + ' нет каталогов roundNN_aN_* с ORIGINAL_raw.bin'); return }
    dir = dirs[dirs.length - 1].dir
  }
  step('🔎 ДИАГНОСТИКА: ' + dir)
  const img = loadRawImage(dir)
  if (!img) { step('❌ не удалось прочитать ORIGINAL_raw.bin (нет файла или размер не сходится с layout.json)'); return }
  step('   размер собранной картинки: ' + img.W + '×' + img.H + ' (' + img.data.length + ' байт)')
  fs.writeFileSync(path.join(dir, 'DIAG_color.png'), colorPng(img.data, img.W, img.H, 2))
  step('   цветная копия: ' + path.join(dir, 'DIAG_color.png'))

  const answers = loadAnswers()
  const num = (path.basename(dir).match(/^round(\d+)/) || [])[1]
  const known = answers.filter(a => String(a.round) === String(num ? Number(num) : ''))
  step('   известный ответ человека: ' + (known.length ? known.map(a => '«' + a.answer + '»').join(', ') : 'НЕТ (импортируйте: --import-answers learn\\telegram.log)'))

  const style = readStyle()
  step('   замок стиля: ' + (style ? style.strategy + (style.locked ? ' (autotune)' : '') : 'нет'))

  let all = []
  try { all = DIG.autoSegment(img.data, img.W, img.H, DIGITS_EXPECTED, {}) || [] } catch (e) { step('❌ autoSegment: ' + e.message); return }
  step('   стратегий перебрано: ' + all.length)
  if (!all.length) {
    step('❌ НИ ОДНА стратегия не дала ровно ' + DIGITS_EXPECTED + ' рамок. Значит маска/полоса не находится вовсе.')
    step('   Пришлите мне DIAG_color.png и этот вывод.')
    return
  }
  console.log('')
  console.log('=== ТОП-10 СТРАТЕГИЙ НА ЭТОЙ КАРТИНКЕ ===')
  console.log('  балл   черн.%  полоса     одинак.кропы  штрих  заполн  стратегия')
  const shown = all.slice(0, 10)
  for (const res of shown) {
    const crops = cropsFromSegResult(res, img.W, img.H, DIGITS_EXPECTED)
    let same = '?', stroke = '?', fill = '?'
    if (crops) {
      let sp = 0, tp = 0
      for (let i = 0; i < crops.length; i++) for (let j = i + 1; j < crops.length; j++) {
        tp++
        let d = 0
        for (let t = 0; t < DIG.GW * DIG.GH; t++) { const x = crops[i].norm[t] - crops[j].norm[t]; d += x * x }
        if (Math.sqrt(d) < 1.2) sp++
      }
      same = Math.round(100 * sp / Math.max(1, tp)) + '%'
      const st = crops.map(c => c.stroke).sort((a, b) => a - b)
      const fl = crops.map(c => c.fill).sort((a, b) => a - b)
      stroke = st[Math.floor(st.length / 2)]
      fill = fl[Math.floor(fl.length / 2)]
    }
    console.log('  ' + String(res.score).padStart(6) + '  ' + String(Math.round(res.inkFrac * 1000) / 10).padStart(5) +
      '  ' + (res.band ? (res.band.y0 + '-' + res.band.y1).padStart(9) : '        ?') +
      '  ' + String(same).padStart(11) + '  ' + String(stroke).padStart(6) + '  ' + String(fill).padStart(7) +
      '   ' + res.name + (res.fallback ? '  [РАВНОМЕРНАЯ НАРЕЗКА — рамки не по цифрам!]' : ''))
  }
  // картинки с рамками для трёх лучших стратегий + ASCII-превью (можно вставить в чат)
  for (const res of shown.slice(0, 3)) {
    try {
      const png = debugSegmentationPng({ data: img.data, W: img.W, H: img.H }, res.boxes, res.band)
      if (png) fs.writeFileSync(path.join(dir, 'DIAG_boxes_' + res.name.replace(/[^a-z0-9_.+-]/gi, '_') + '.png'), png)
    } catch (e) {}
    const crops = cropsFromSegResult(res, img.W, img.H, DIGITS_EXPECTED)
    if (!crops) continue
    console.log('')
    console.log('--- «' + res.name + '» балл ' + res.score + ' — ЧТО Я ВИЖУ (ASCII, слева направо) ---')
    console.log(asciiRow(crops))
    try {
      const sheet = contactSheetPng([crops.map(c => ({ norm: c.norm }))])
      if (sheet) fs.writeFileSync(path.join(dir, 'DIAG_crops_' + res.name.replace(/[^a-z0-9_.+-]/gi, '_') + '.png'), sheet)
    } catch (e) {}
  }
  console.log('')
  step('✅ файлы диагностики лежат в ' + dir + ' (DIAG_color.png, DIAG_boxes_*.png, DIAG_crops_*.png)')
  step('   Скопируйте в чат ASCII-блоки выше — по ним видно, цифра в кропе или шум.')
}

// ========================= ЗАПИСЬ РАУНДА =========================
function readStyle() {
  try {
    const p = path.join(LEARN_DIR, 'style.json')
    if (!fs.existsSync(p)) return null
    const o = JSON.parse(fs.readFileSync(p, 'utf8'))
    return (o && o.strategy) ? o : null
  } catch (e) { return null }
}
function writeStyle(strategy, score, extra) {
  try {
    fs.mkdirSync(LEARN_DIR, { recursive: true })
    const prev = readStyle() || { rounds: 0 }
    fs.writeFileSync(path.join(LEARN_DIR, 'style.json'), JSON.stringify({
      strategy, score, extra: extra || null,
      rounds: (prev.rounds || 0) + 1,
      sameAsBefore: prev.strategy === strategy,
      updated: new Date().toISOString()
    }, null, 2))
  } catch (e) {}
}

// картинка капчи с нарисованными рамками цифр — главная диагностика сегментации
function debugSegmentationPng(asm, boxes, band) {
  try {
    const W = asm.W, H = asm.H
    const inBox = new Uint8Array(W * H)
    for (const b of (boxes || [])) {
      if (!b) continue
      for (let x = b.mnX; x <= b.mxX; x++) { if (b.mnY >= 0) inBox[b.mnY * W + x] = 1; if (b.mxY < H) inBox[b.mxY * W + x] = 1 }
      for (let y = b.mnY; y <= b.mxY; y++) { if (b.mnX >= 0) inBox[y * W + b.mnX] = 1; if (b.mxX < W) inBox[y * W + b.mxX] = 1 }
    }
    const bandLine = new Uint8Array(W * H)
    if (band) for (let x = 0; x < W; x++) { bandLine[band.y0 * W + x] = 1; bandLine[band.y1 * W + x] = 1 }
    return DIG.pngRgba(W, H, 1, (x, y) => {
      const v = asm.data[y * W + x]
      let r = PALETTE[v * 3], g = PALETTE[v * 3 + 1], bl = PALETTE[v * 3 + 2]
      if (bandLine[y * W + x]) { r = 40; g = 120; bl = 255 }
      if (inBox[y * W + x]) { r = 255; g = 40; bl = 40 }
      return [r, g, bl]
    })
  } catch (e) { return null }
}

async function saveRecord(outDir, snap, label, roundNo, opts) {
  const LIGHT = !!(opts && opts.light)
  fs.mkdirSync(outDir, { recursive: true })
  const frames = (snap.frames || []).map(f => Object.assign({}, f))
  const tiles = snap.maps
  fs.writeFileSync(path.join(outDir, 'frames.json'), JSON.stringify(frames, null, 2))
  fs.writeFileSync(path.join(outDir, 'chat.log'), (snap.chats || []).join('\n'))
  fs.writeFileSync(path.join(outDir, 'session_log.txt'), (snap.events || []).join('\n'))
  if (snap.view) fs.writeFileSync(path.join(outDir, 'view.json'), JSON.stringify(snap.view, null, 2))
  try { fs.writeFileSync(path.join(outDir, 'metadata_dump.json'), JSON.stringify(snap.metaDump || [], null, 2)) } catch (e) {}

  const linked = frames.filter(f => f.mapId !== null && f.mapId !== undefined && tiles.has(f.mapId))
  step(label + ': frames=' + frames.length + ' linked=' + linked.length + ' maps=' + tiles.size)

  if (!linked.length) {
    const d = [
      'ДИАГНОСТИКА: нет ни одной рамки со ссылкой на карту (map_id).',
      'frames всего: ' + frames.length + ', карт получено (map_data): ' + tiles.size,
      'Смотрите metadata_dump.json — там сырые метаданные рамок.',
      'Если файл пустой, значит метаданные item_frame не приходят вовсе.'
    ]
    fs.writeFileSync(path.join(outDir, 'DIAGNOSTICS.txt'), d.join('\n') + '\n')
    step(label + ': ❌ нет linked-рамок (см. DIAGNOSTICS.txt)')
    return null
  }

  const minFrames = wallMinFrames(linked.length)
  const walls = detectWalls(linked, minFrames)
  if (!walls.length) {
    step(label + ': ❌ стен не найдено (нужно ≥' + minFrames + ' рамок в одной плоскости, без рваных сеток)')
    fs.writeFileSync(path.join(outDir, 'FAIL.txt'), 'no walls detected; linked=' + linked.length + '\n')
    return null
  }
  step(label + ': плоскостей-кандидатов: ' + walls.map(w => w.tag + '(' + w.frames.length + ',gap' + w.gap + ')').join(', '))

  // ---- база цифр (обучаемая) ----
  let store = null, model = null, queue = null
  try {
    store = new DIG.GlyphStore(LEARN_DIR, { augment: DIG_AUGMENT })
    model = DIG.MLP.load(LEARN_DIR)
    queue = new DIG.LabelQueue(LEARN_DIR)
    if (roundNo === 1 || DIG_LOG_ONCE.v !== store.size) {
      DIG_LOG_ONCE.v = store.size
      step('[digits] база: ' + store.size + ' размеченных глифов ' + JSON.stringify(store.counts()) + (model ? ' | MLP загружена' : ' | MLP нет (нужно --train)'))
    }
  } catch (e) { step('[digits] модуль недоступен: ' + e.message) }

  const styleInfo = readStyle()
  const styleHint = styleInfo ? styleInfo.strategy : null
  if (styleHint) dbg('замок стиля: маска ' + styleHint + ' (раундов ' + styleInfo.rounds + ')')

  const stats = []
  for (const w of walls.slice(0, 6)) {
    let asm = null
    try { asm = assembleWallSmart(w, tiles, snap.view, {}) } catch (e) { step(label + ' ' + w.tag + ': assemble err ' + e.message) }
    if (!asm) continue

    const im = inkMaskWall(asm.data, asm.W, asm.H)
    let rec = { text: '', textAll: '', prediction: '', complete: !DIGITS_EXPECTED, confident: false, avgConf: 0, expected: DIGITS_EXPECTED, items: [], needLabel: [], rowCount: 0, allCount: 0 }
    let glyphs = [], seg = null, segPath = 'none'
    if (store) {
      if (DIGITS_EXPECTED > 0) {
        try {
          const t0 = Date.now()
          seg = DIG.extractDigitsSmart(asm.data, asm.W, asm.H, DIGITS_EXPECTED, { prefer: styleHint })
          seg.ms = Date.now() - t0
        } catch (e) { dbg('smart segment err ' + e.message); seg = null }
      }
      const segOk = seg && seg.glyphs && seg.glyphs.length === DIGITS_EXPECTED && seg.score >= SEG_MIN_SCORE
      if (segOk) {
        glyphs = seg.glyphs
        segPath = 'smart:' + seg.strategy + (seg.fastPath ? '(замок стиля)' : '')
        rec = DIG.recognize(glyphs, store, model, { confOk: DIG_CONF_OK, expected: DIGITS_EXPECTED, presorted: true })
      } else {
        try {
          glyphs = DIG.extractGlyphs(im.ink, asm.W, asm.H, GLYPH_OPTS)
          segPath = 'components'
          rec = DIG.recognize(glyphs, store, model, { confOk: DIG_CONF_OK, expected: DIGITS_EXPECTED })
        } catch (e) { dbg('glyphs err ' + e.message) }
      }
    }

    const dot = wallDot(w, snap.view)
    const dist = wallDist(w, snap.view)
    const fillRatio = asm.placed / Math.max(1, asm.grid.total)

    // ---- скоринг: геометрия важнее, локальное распознавание — вспомогательный сигнал ----
    const seamPenalty = Math.max(0, asm.seamCost <= 25 ? asm.seamCost * 12 : 300 + (asm.seamCost - 25) * 40)
    const sizeBonus = asm.placed * 90
    const fillBonus = Math.round(fillRatio * 1500)
    // Дистанция — самый надёжный признак: бота телепортируют вплотную к СВОЕЙ капче
    // (в вашем логе 2.4-3.7 блока у правильной стены и десятки у соседней).
    // yaw (dot) ненадёжен: сервер не всегда его ставит, поэтому вес маленький.
    const distBonus = dist === null ? 0
      : (dist <= 6 ? 2200 : dist <= 12 ? 1500 : dist <= 20 ? 700 : dist <= 35 ? 0 : dist <= 60 ? -1500 : -3000)
    const dotBonus = dot === null ? 0
      : (dot >= 0.7 ? 500 : dot >= 0.2 ? 150 : dot >= -0.3 ? -150 : -500)
    const confident = rec.items.filter(i => i.conf >= DIG_CONF_OK).length
    const digitBonus = Math.min(900, (rec.text.length >= 3 ? 500 : 0) + confident * 100)
    const gapPenalty = w.contiguous ? 0 : 1200
    const yawPenalty = w.yawSpread > 0.6 ? 1500 : 0
    const score = Math.round(sizeBonus + fillBonus + dotBonus + distBonus + digitBonus - seamPenalty - gapPenalty - yawPenalty)

    stats.push({
      w, asm, im, glyphs, rec, seg, segPath, dot, dist, fillRatio, score,
      breakdown: {
        sizeBonus, fillBonus, dotBonus, distBonus, digitBonus,
        seamPenalty: Math.round(seamPenalty), gapPenalty, yawPenalty,
        seamCost: asm.seamCost, contiguous: w.contiguous, gap: w.gap, yawSpread: w.yawSpread,
        digitsText: rec.text, digitsAll: rec.textAll, glyphsRow: rec.rowCount, glyphsAll: rec.allCount
      }
    })
  }

  if (!stats.length) { step(label + ': ❌ ни одна стена не собралась'); fs.writeFileSync(path.join(outDir, 'FAIL.txt'), 'no wall assembled\n'); return null }
  stats.sort((a, b) => b.score - a.score)
  const best = stats[0]
  const asm = best.asm

  // ---- отладка выбора стены ----
  try {
    fs.writeFileSync(path.join(outDir, 'walls_debug.json'), JSON.stringify({
      chosen: best.w.tag, view: snap.view || null,
      candidates: stats.map(s => Object.assign({ wall: s.w.tag, axis: s.w.axis, value: s.w.value,
        cols: s.asm.grid.cols, rows: s.asm.grid.rows, placed: s.asm.placed, total: s.asm.grid.total,
        orientation: s.asm.ori.tag, rotationRule: s.asm.rotRule, permUsed: s.asm.permUsed,
        score: s.score }, s.breakdown))
    }, null, 2))
  } catch (e) {}

  // ---- сохраняем лучшую ----
  fs.writeFileSync(path.join(outDir, 'ORIGINAL_CAPTCHA.png'), colorPng(asm.data, asm.W, asm.H, 2))
  fs.writeFileSync(path.join(outDir, 'ORIGINAL_CAPTCHA_x1.png'), colorPng(asm.data, asm.W, asm.H, 1))
  if (!LIGHT) fs.writeFileSync(path.join(outDir, 'ORIGINAL_CAPTCHA_mask.png'), bwPng(best.im.ink, asm.W, asm.H, 2))
  fs.writeFileSync(path.join(outDir, 'ORIGINAL_raw.bin'), Buffer.from(asm.data))
  fs.writeFileSync(path.join(outDir, 'layout.json'), JSON.stringify(asm.layout, null, 2))
  fs.writeFileSync(path.join(outDir, 'assembly_debug.json'), JSON.stringify({
    wall: best.w.tag, axis: best.w.axis, value: best.w.value, gap: best.w.gap, contiguous: best.w.contiguous,
    yawSpread: best.w.yawSpread,
    cols: asm.grid.cols, rows: asm.grid.rows, cells: asm.grid.total,
    placed: asm.placed, missing: asm.missing, holesFilled: asm.holesFilled, holeAssignments: asm.holeAssignments,
    orientation: asm.ori, rotationRule: asm.rotRule, permUsed: asm.permUsed, colPerm: asm.colPerm,
    seamCost: asm.seamCost, natSeamCost: asm.natSeamCost, permSeamCost: asm.permSeamCost,
    view: snap.view || null, dot: best.dot, dist: best.dist, trials: asm.trials,
    inkDensity: best.fillRatio, digits: { text: best.rec.text, all: best.rec.textAll }
  }, null, 2))

  // ---- тяжёлые отладочные артефакты: в быстром режиме пропускаем ----
  if (!LIGHT) {
    fs.mkdirSync(path.join(outDir, 'tiles'), { recursive: true })
    let ti = 0
    for (const f of linked) {
      const raw = tiles.get(f.mapId)
      if (raw) fs.writeFileSync(path.join(outDir, 'tiles', 'tile_' + String(ti++).padStart(2, '0') + '_map' + f.mapId + '_rot' + (f.rotation || 0) + '.bin'), Buffer.from(raw))
    }
    fs.mkdirSync(path.join(outDir, 'variants'), { recursive: true })
    const vars = buildVariants(best.im.ink, asm.W, asm.H)
    const ocrLines = []
    for (const v of vars) {
      try { fs.writeFileSync(path.join(outDir, 'variants', v.name + '.png'), bwPng(v.mask, asm.W, asm.H, 2)) } catch (e) {}
      const r = ocr(v.mask, asm.W, asm.H)
      ocrLines.push(v.name + ': legacy-ocr="' + r.text + '" digits=' + r.digits.length)
    }
    fs.writeFileSync(path.join(outDir, 'ocr_variants.txt'), ocrLines.join('\n'))
  }

  // ---- диагностика сегментации: картинка с рамками + отчёт по всем стратегиям ----
  if (best.seg) {
    try {
      const dbgPng = debugSegmentationPng(asm, best.seg.boxes, best.seg.band)
      if (dbgPng) fs.writeFileSync(path.join(outDir, 'debug_segmentation.png'), dbgPng)
      fs.writeFileSync(path.join(outDir, 'segmentation_report.json'), JSON.stringify({
        used: best.segPath, strategy: best.seg.strategy, score: best.seg.score,
        fastPath: !!best.seg.fastPath, triedStrategies: best.seg.tried, ms: best.seg.ms,
        preferred: best.seg.preferred, inkFrac: best.seg.inkFrac, color: best.seg.extra,
        band: best.seg.band ? { y0: best.seg.band.y0, y1: best.seg.band.y1, share: best.seg.band.share } : null,
        boxes: (best.seg.boxes || []).map(b => b ? { x0: b.mnX, x1: b.mxX, y0: b.mnY, y1: b.mxY, w: b.w, h: b.h, area: b.area } : null),
        topStrategies: best.seg.strategies
      }, null, 2))
    } catch (e) { dbg('seg debug err ' + e.message) }
    if (best.seg.score >= STYLE_LOCK_MIN) writeStyle(best.seg.strategy, best.seg.score, best.seg.extra)
  }

  // ---- глиф-кандидаты и распознавание ----
  const glyphDir = path.join(outDir, 'glyphs')
  let queued = 0
  if (store && best.glyphs.length) {
    try { fs.mkdirSync(glyphDir, { recursive: true }) } catch (e) {}
    best.rec.items.forEach((it, i) => {
      try {
        const g = it.glyph
        fs.writeFileSync(path.join(glyphDir, 'g' + i + '_' + (it.digit === null ? 'none' : it.digit) + '_' + String(Math.round(it.conf * 100)) + '.png'),
          DIG.pngFromMask(best.im.ink, asm.W, asm.H, g.bbox, 3))
      } catch (e) {}
    })
    try {
      queued = DIG.enqueueGlyphs(queue, best.rec.needLabel, { src: path.basename(outDir), round: roundNo, wall: best.w.tag })
    } catch (e) { dbg('queue err ' + e.message) }
  }
  try {
    fs.writeFileSync(path.join(outDir, 'digits.json'), JSON.stringify({
      text: best.rec.text, textAll: best.rec.textAll, prediction: best.rec.prediction,
      expected: DIGITS_EXPECTED, complete: best.rec.complete, confident: best.rec.confident, avgConf: best.rec.avgConf,
      rowCount: best.rec.rowCount, allGlyphs: best.rec.allCount,
      needLabel: best.rec.needLabel.length, queued,
      model: model ? 'mlp+knn' : (store && store.size ? 'knn' : 'нет (база пуста — запустите node main.js --label)'),
      items: best.rec.items.map(it => ({
        x: it.x, y: it.y, w: it.w, h: it.h, digit: it.digit, conf: it.conf, method: it.method,
        knn: it.knn, mlp: it.mlp
      }))
    }, null, 2))
  } catch (e) {}

  // ---- декаи (в быстром режиме не рисуем, счёт остаётся в walls_debug.json) ----
  if (!LIGHT) {
    for (const s of stats.slice(1)) {
      try { fs.writeFileSync(path.join(outDir, 'DECOY_NOT_ORIGINAL_' + s.w.tag + '.png'), colorPng(s.asm.data, s.asm.W, s.asm.H, 2)) } catch (e) {}
    }
  }

  // ---- плоская копия в records/captchas ----
  let capFile = null
  if (CAP_ROOT && roundNo) {
    try {
      fs.mkdirSync(CAP_ROOT, { recursive: true })
      capFile = 'round_' + String(roundNo).padStart(2, '0') + '.png'
      fs.writeFileSync(path.join(CAP_ROOT, capFile), colorPng(asm.data, asm.W, asm.H, 2))
      fs.writeFileSync(path.join(CAP_ROOT, capFile.replace(/\.png$/, '.json')), JSON.stringify({
        round: roundNo, wall: best.w.tag, cols: asm.grid.cols, rows: asm.grid.rows,
        placed: asm.placed, missing: asm.missing, holesFilled: asm.holesFilled,
        orientation: asm.ori, rotationRule: asm.rotRule, permUsed: asm.permUsed,
        seamCost: asm.seamCost, score: best.score, dot: best.dot, dist: best.dist,
        digits: best.rec.text, digitsAll: best.rec.textAll, prediction: best.rec.prediction,
        glyphs: best.rec.rowCount + '/' + DIGITS_EXPECTED, avgConf: best.rec.avgConf, needLabel: best.rec.needLabel.length,
        candidates: stats.map(s => ({ wall: s.w.tag, score: s.score, cols: s.asm.grid.cols, rows: s.asm.grid.rows })),
        dir: path.relative(REC_ROOT, outDir), view: snap.view || null
      }, null, 2))
    } catch (e) { step('captchas copy err: ' + e.message) }
  }

  step(label + ': ✅ ORIGINAL=' + best.w.tag + ' ' + asm.grid.cols + '×' + asm.grid.rows +
    ' placed=' + asm.placed + '/' + asm.grid.total +
    ' ori=' + asm.ori.tag + '(hAsc=' + asm.ori.hAsc + ')' +
    ' rot=' + asm.rotRule + (asm.permUsed ? ' PERM!' : '') +
    ' seam=' + asm.seamCost + ' dot=' + (best.dot === null ? '?' : best.dot.toFixed(2)) +
    ' dist=' + (best.dist === null ? '?' : best.dist) +
    ' score=' + best.score + ' / конкуренты: ' + stats.slice(1).map(s => s.w.tag + '=' + s.score).join(',') )
  if (asm.seamCost > SEAM_WARN) {
    step(label + ': ⚠️ ВНИМАНИЕ: швы плохие (seam=' + asm.seamCost + ' > ' + SEAM_WARN +
      ') — картинка может быть собрана неверно. Проверьте ORIGINAL_CAPTCHA.png' +
      (TRY_COL_PERMS ? '' : '; при необходимости запустите с --perms'))
  }
  step(label + ': 🧩 сегментация: ' + best.segPath +
    (best.seg ? ' балл=' + best.seg.score + ' стратегий=' + best.seg.tried + ' за ' + best.seg.ms + 'мс полоса=[' +
      (best.seg.band ? best.seg.band.y0 + '-' + best.seg.band.y1 : '?') + ']' +
      (best.seg.extra && best.seg.extra.color !== undefined ? ' цвет=' + best.seg.extra.color : '') : '') +
    (best.seg && best.seg.score < SEG_MIN_SCORE ? ' ⚠️ балл ниже порога ' + SEG_MIN_SCORE + ' — откат к компонентам' : ''))
  step(label + ': 🔢 ПРЕДСКАЗАНИЕ="' + best.rec.prediction + '" уверенных="' + best.rec.text +
    '" ср.уверенность=' + best.rec.avgConf +
    ' глифов=' + best.rec.rowCount + (DIGITS_EXPECTED ? '/' + DIGITS_EXPECTED : '') + ' кандидатов=' + best.rec.allCount +
    (DIGITS_EXPECTED && !best.rec.complete ? ' ⚠️ НАШЛОСЬ НЕ ' + DIGITS_EXPECTED + ' ЦИФР' : '') +
    (queued ? ' | в очередь: +' + queued : ''))

  return {
    wall: best.w.tag, cols: asm.grid.cols, rows: asm.grid.rows,
    tilesCount: asm.placed, tilesExpected: asm.grid.total, missing: asm.missing, holesFilled: asm.holesFilled,
    ori: asm.ori.tag, hAsc: asm.ori.hAsc, yAsc: asm.ori.yAsc, rotRule: asm.rotRule, permUsed: asm.permUsed, colPerm: asm.colPerm,
    seamCost: asm.seamCost, natSeamCost: asm.natSeamCost, score: best.score, dot: best.dot, dist: best.dist,
    digits: best.rec.text, digitsAll: best.rec.textAll, prediction: best.rec.prediction,
    glyphCount: best.rec.rowCount, glyphsExpected: DIGITS_EXPECTED, glyphsComplete: best.rec.complete,
    avgConf: best.rec.avgConf, needLabel: best.rec.needLabel.length, queued,
    // признаки глифов — нужны, чтобы разметить ответом из Telegram
    digitItems: (best.rec.items || []).map(it => ({
      x: it.x, y: it.y, w: it.w, h: it.h,
      guess: it.digit, conf: it.conf, method: it.method,
      bbox: it.glyph ? it.glyph.bbox : null,
      feat: it.glyph ? it.glyph.feat : null
    })),
    segPath: best.segPath, segStrategy: best.seg ? best.seg.strategy : null, segScore: best.seg ? best.seg.score : null,
    // диагностика качества нарезки: degenerate=true → кропы одинаковые («88888»),
    // такую разметку нельзя класть в базу (см. runAutotune / --diag)
    segDegenerate: best.seg ? !!best.seg.degenerate : false,
    segSameFrac: best.seg && best.seg.sameFrac != null ? best.seg.sameFrac : null,
    segFallback: best.seg ? !!best.seg.fallback : null,
    segMedStroke: best.seg && best.seg.medStroke != null ? best.seg.medStroke : null,
    pngFile: path.join(outDir, 'ORIGINAL_CAPTCHA_x1.png'),
    pngFile2x: path.join(outDir, 'ORIGINAL_CAPTCHA.png'),
    candidates: stats.map(s => ({ wall: s.w.tag, score: s.score, breakdown: s.breakdown })),
    inkDensity: Math.round(best.im.inkCount / (asm.W * asm.H) * 10000) / 10000,
    layout: asm.layout, dir: outDir, capFile, originalFile: 'ORIGINAL_CAPTCHA.png'
  }
}

const DIG_LOG_ONCE = { v: -1 }

// ========================= ЗАХВАТ =========================
function connectAndCapture(tag) {
  return new Promise(resolve => {
    const col = {
      maps: new Map(), mapFilled: new Map(), mapUpdatedAt: new Map(),
      frames: [], framesById: new Map(), chats: [], events: [], prompts: 0,
      dead: false, reason: '', metaDump: [], firstFrameAt: 0, lastMapAt: 0, lastChangeAt: 0
    }
    const ev = s => { col.events.push(new Date().toISOString().slice(11, 23) + ' ' + s); step('[' + tag + '] ' + s) }

    let finished = false, bot = null
    let pollT = null, hardT = null, settleT = null, loginT = null, spawnT = null
    let readySince = 0

    const linkedFrames = () => col.frames.filter(f => f.mapId !== null && f.mapId !== undefined && col.maps.has(f.mapId))

    function bestWallNow() {
      const linked = linkedFrames()
      if (linked.length < 2) return null
      const walls = detectWalls(linked, wallMinFrames(linked.length))
      return walls.length ? walls[0] : null
    }
    function readiness() {
      const w = bestWallNow()
      if (!w) return { ready: false, why: 'нет стены', have: 0, need: 0, total: 0 }
      const grid = buildGrid(w)
      const cells = grid.cells.filter(f => f && col.maps.has(f.mapId))
      const have = cells.length
      // плитка ПОЛНОСТЬЮ получена, если пришли все 16384 байта (128×128).
      // Это намного быстрее, чем ждать «тишины» в потоке пакетов.
      const full = cells.filter(f => (col.mapFilled.get(f.mapId) || 0) >= 16384).length
      const allComplete = full >= grid.total && grid.total > 0
      const stableMs = FAST_MODE ? FAST.stableMs : CAP.stableMs
      // «тишина»: ни новых рамок, ни новых метаданных, ни новых байт карты
      const quiet = col.lastChangeAt ? (Date.now() - col.lastChangeAt) >= stableMs : true
      const need = Math.max(CAP.minTiles, Math.ceil(grid.total * MIN_TILES_FRACTION))
      const enough = have >= Math.min(need, grid.total)
      const promptOk = CAP.needPrompt ? col.prompts >= 1 : true
      const ok = enough && (allComplete || quiet) && promptOk
      return {
        ready: ok, allComplete, full,
        why: ok ? (allComplete ? 'ok(все байты)' : 'ok(тишина)')
          : (!enough ? 'не хватает плиток (' + have + '/' + Math.min(need, grid.total) + ')'
            : (!quiet ? 'ждём тишины ' + stableMs + 'мс' : 'ждём промпт капчи')),
        have, need: Math.min(need, grid.total), total: grid.total, quiet
      }
    }

    const finish = (ok, note) => {
      if (finished) return
      finished = true
      for (const t of [hardT, loginT, spawnT, settleT]) { try { if (t) clearTimeout(t) } catch (e) {} }
      try { if (pollT) clearInterval(pollT) } catch (e) {}
      let view = null
      try { if (bot && bot.entity && bot.entity.position) view = { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z, yaw: bot.entity.yaw, pitch: bot.entity.pitch } } catch (e) {}
      const snap = {
        maps: col.maps, frames: col.frames.map(f => Object.assign({}, f)),
        chats: col.chats.slice(), events: col.events.slice(), view, metaDump: col.metaDump.slice(0, 6)
      }
      try { if (bot) bot.end('done') } catch (e) {}
      resolve(ok ? { ok: true, snap, note } : { ok: false, note: note || col.reason || 'fail' })
    }

    if (!mineflayer) { finish(false, 'mineflayer не установлен (npm i mineflayer)'); return }
    hardT = setTimeout(() => {
      const r = readiness()
      ev('жёсткий таймаут ' + (CAP.timeoutMs / 1000) + 'с: have=' + r.have + '/' + (r.total || '?'))
      finish(r.have >= CAP.minTiles, 'timeout(have=' + r.have + ')')
    }, CAP.timeoutMs)

    if (!PROXY.host) { finish(false, 'нет proxy.host в конфиге'); return }

    // прокси с резервными хостами: bproxy.site <-> mproxy.site (тот же порт у MobileProxy.Space)
    proxyConnect(MC.host, MC.port, CONNECT_TIMEOUT_MS).then(sock => {
      const conn = { socket: sock }
      ev('socks ok -> ' + MC.host + ':' + MC.port + (PROXY_OK_HOST && PROXY_OK_HOST !== PROXY.host ? ' (через резерв ' + PROXY_OK_HOST + ')' : ''))
      const nick = (NICK_PREFIX + Math.floor(Math.random() * 9000 + 1000)).slice(0, 16)
      const tConn = Date.now()
      spawnT = setTimeout(() => { if (!finished) finish(false, 'spawn timeout') }, CONNECT_TIMEOUT_MS)
      loginT = setTimeout(() => { if (!finished) { ev('login timeout ' + (LOGIN_TIMEOUT_MS / 1000) + 'с'); finish(false, 'login timeout') } }, LOGIN_TIMEOUT_MS)

      bot = mineflayer.createBot({
        username: nick, host: MC.host, port: MC.port, version: MC.version,
        socket: conn.socket, hideErrors: true, auth: 'offline', keepAlive: true, checkTimeoutInterval: 60
      })

      // ---------- map_data ----------
      const onMap = pkt => {
        try {
          const id = getMapIdFromPacket(pkt)
          if (id === null) return
          const cols = pkt.columns || 0, rows = pkt.rows || 0
          if (!cols || !rows) return
          const buf = toBuf(pkt.data)
          if (!buf || !buf.length) return
          let canvas = col.maps.get(id)
          if (!canvas) { canvas = new Uint8Array(16384); col.maps.set(id, canvas); col.mapFilled.set(id, 0) }
          const x0 = pkt.x || 0, y0 = pkt.y || 0
          let touched = 0
          const n = Math.min(buf.length, cols * rows)
          for (let i = 0; i < n; i++) {
            const cx = x0 + (i % cols), cy = y0 + Math.floor(i / cols)
            if (cx < 0 || cy < 0 || cx >= 128 || cy >= 128) continue
            canvas[cy * 128 + cx] = buf[i]; touched++
          }
          col.mapFilled.set(id, (col.mapFilled.get(id) || 0) + touched)
          col.mapUpdatedAt.set(id, Date.now())
          col.lastMapAt = Date.now()
          col.lastChangeAt = Date.now()
          if (col.maps.size <= 3 || (col.maps.size % 8 === 0)) dbg('map ' + id + ' +' + touched + ' px (' + cols + '×' + rows + ' @' + x0 + ',' + y0 + ')')
        } catch (e) { dbg('onMap err ' + e.message) }
      }
      for (const nm of ['map_data', 'map', 'update_map']) { try { bot._client.on(nm, onMap) } catch (e) {} }

      // ---------- рамки ----------
      const isFrameName = e => /item_frame/i.test(String((e && (e.name || e.displayName || e.type || e.entityType || e.kind)) || ''))
      function addFrame(id, pos, info) {
        if (col.framesById.has(id)) return col.framesById.get(id)
        const f = { id, x: pos.x, y: pos.y, z: pos.z, mapId: null, rotation: 0, metaSeen: false, yaw: (pos && typeof pos.yaw === 'number') ? pos.yaw : null }
        if (info) {
          if (info.mapId !== null && info.mapId !== undefined) { f.mapId = info.mapId; f.metaSeen = true }
          if (info.rotation !== null && info.rotation !== undefined) f.rotation = info.rotation
        }
        col.frames.push(f); col.framesById.set(id, f)
        if (!col.firstFrameAt) col.firstFrameAt = Date.now()
        col.lastChangeAt = Date.now()
        return f
      }
      function applyMeta(f, meta) {
        const info = extractFrameInfo(meta)
        f.metaSeen = true
        if (!info) {
          // метаданные есть, но map_id не распознан — сохраним сырьё для диагностики
          if (!f.dumped && col.metaDump.length < 6) {
            f.dumped = true
            try { col.metaDump.push({ entityId: f.id, problem: 'map_id не найден в метаданных', raw: JSON.parse(JSON.stringify(meta)) }) } catch (e) {}
          }
          return false
        }
        let changed = false
        if (info.mapId !== null && info.mapId !== undefined && f.mapId !== info.mapId) { f.mapId = info.mapId; changed = true }
        if (info.rotation !== null && info.rotation !== undefined && f.rotation !== info.rotation) { f.rotation = info.rotation; changed = true }
        if (changed) {
          col.lastChangeAt = Date.now()
          if (col.metaDump.length < 6) {
            try { col.metaDump.push({ entityId: f.id, mapId: f.mapId, rotation: f.rotation, raw: JSON.parse(JSON.stringify(meta)) }) } catch (e) {}
          }
        }
        return changed
      }

      bot.on('entitySpawn', ent => {
        try {
          if (!ent || !ent.position) return
          if (!isFrameName(ent)) return
          const info = ent.metadata ? extractFrameInfo(ent.metadata) : null
          // yaw у item_frame кодирует направление «лица» рамки — по его разбросу
          // мы отличаем настоящую стену от сквозного артефакта из двух параллельных стен
          const pos = { x: ent.position.x, y: ent.position.y, z: ent.position.z, yaw: (typeof ent.yaw === 'number' ? ent.yaw : null) }
          const f = addFrame(ent.id, pos, info)
          if (f && !f.metaSeen && ent.metadata) applyMeta(f, ent.metadata)
          dbg('frame #' + ent.id + ' ' + String(ent.name || ent.displayName || '') + ' @' + ent.position.x.toFixed(2) + ',' + ent.position.y.toFixed(2) + ',' + ent.position.z.toFixed(2) + (f && f.mapId !== null ? ' map=' + f.mapId + ' rot=' + f.rotation : ''))
        } catch (e) { dbg('entitySpawn err ' + e.message) }
      })

      // имя пакета метаданных differs по версиям: entity_metadata / set_entity_metadata /
      // set_entity_data — слушаем все варианты сразу
      const onMetaPkt = pk => {
        try {
          const f = col.framesById.get(pk.entityId)
          if (f) { applyMeta(f, pk.metadata); return }
          // рамка могла прийти метаданными раньше, чем spawn
          const info = extractFrameInfo(pk.metadata)
          if (info && info.mapId !== null && bot && bot.entities && bot.entities[pk.entityId] && bot.entities[pk.entityId].position) {
            addFrame(pk.entityId, bot.entities[pk.entityId].position, info)
          }
        } catch (e) { dbg('meta pkt err ' + e.message) }
      }
      for (const nm of ['set_entity_metadata', 'entity_metadata', 'set_entity_data', 'entityMetadata']) { try { bot._client.on(nm, onMetaPkt) } catch (e) {} }

      // подстраховка: читаем уже распарсенные метаданные из mineflayer
      function scanEntities() {
        if (!bot || !bot.entities) return
        for (const key in bot.entities) {
          const e = bot.entities[key]
          if (!e || !e.position) continue
          const id = Number(key)
          let f = col.framesById.get(id)
          if (!f) {
            // берём всё, что похоже на рамку; а если имя не распознано —
            // смотрим, нет ли в метаданных map_id (подстраховка от странностей registry)
            let adopt = isFrameName(e)
            let info = null
            if (!adopt && e.metadata) {
              info = extractFrameInfo(e.metadata)
              adopt = !!(info && info.mapId !== null && info.mapId !== undefined)
            }
            if (!adopt) continue
            f = addFrame(id, { x: e.position.x, y: e.position.y, z: e.position.z, yaw: (typeof e.yaw === 'number' ? e.yaw : null) }, info)
            if (adopt && !isFrameName(e)) ev('внимание: сущность #' + id + ' (' + String(e.name || e.type || '?') + ') не item_frame, но держит карту — считаю рамкой')
          }
          if (f && typeof e.yaw === 'number' && f.yaw === null) f.yaw = e.yaw
          if (f && e.metadata && (f.mapId === null || f.mapId === undefined || !f.metaSeen)) applyMeta(f, e.metadata)
        }
      }

      // ---------- чат / title / actionbar ----------
      const PROMPT_RE = /введи|введите|номер|цифр|капч|captcha|код с|число/i
      const onText = (t, src) => {
        const s = String(t || '')
        if (!s) return
        col.chats.push('[' + src + '] ' + s)
        if (PROMPT_RE.test(s) && /номер|цифр|капч|captcha|код|число/i.test(s)) { col.prompts++; ev('промпт капчи #' + col.prompts + ' (' + src + '): ' + s.slice(0, 80)) }
      }
      bot.on('message', m => { let t = ''; try { t = m.toString() } catch (e) {}; onText(t, 'chat') })
      try { bot.on('messagestr', s => onText(s, 'chatstr')) } catch (e) {}
      for (const nm of ['set_title_text', 'set_title_subtitle', 'set_action_bar_text', 'system_chat', 'disguised_chat', 'set_title_title']) {
        try {
          bot._client.on(nm, pk => {
            let t = ''
            try {
              if (typeof pk.text === 'string') t = pk.text
              else if (pk.text && typeof pk.text === 'object') t = JSON.stringify(pk.text)
              else if (pk.content) t = typeof pk.content === 'string' ? pk.content : JSON.stringify(pk.content)
              t = t.replace(/\\u[0-9a-f]{4}/gi, '')
            } catch (e) {}
            onText(t, nm)
          })
        } catch (e) {}
      }

      bot.on('login', () => { try { clearTimeout(loginT) } catch (e) {}; ev('login ok (' + nick + ') за ' + (Date.now() - tConn) + 'мс') })
      bot.on('spawn', () => { try { clearTimeout(spawnT) } catch (e) {}; ev('spawn ok за ' + (Date.now() - tConn) + 'мс') })
      bot.on('kicked', r => {
        if (finished) return
        col.dead = true; col.reason = 'kicked'
        ev('kicked: ' + String((r && (r.reason || r.message)) || r || '').slice(0, 140))
        const rd = readiness()
        setTimeout(() => { if (!finished) finish(rd.have >= CAP.minTiles, 'kicked(have=' + rd.have + ')') }, 400)
      })
      bot.on('end', reason => {
        if (finished) return
        col.dead = true
        if (!col.reason) col.reason = 'end: ' + String(reason || '').slice(0, 100)
        ev(col.reason)
        const rd = readiness()
        setTimeout(() => { if (!finished) finish(rd.have >= CAP.minTiles, col.reason + '(have=' + rd.have + ')') }, 400)
      })
      bot.on('error', e => {
        if (finished) return
        col.dead = true
        if (!col.reason) col.reason = 'error: ' + e.message
        ev(col.reason)
        const rd = readiness()
        if (rd.have < CAP.minTiles) finish(false, col.reason)
      })

      pollT = setInterval(() => {
        if (finished) return
        try { scanEntities() } catch (e) {}
        const rd = readiness()
        if (rd.ready) {
          const settleMs = FAST_MODE ? FAST.settleMs : SETTLE_MS
          if (!readySince) { readySince = Date.now(); ev('данные готовы (' + rd.why + '): ' + rd.have + '/' + rd.total + ' — добираю ' + settleMs + 'мс') }
          if (!settleT) settleT = setTimeout(() => finish(true, 'captured ' + rd.have + '/' + rd.total + ' ' + rd.why), settleMs)
        } else {
          readySince = 0
          if (settleT) { clearTimeout(settleT); settleT = null }
          if (col.dead && rd.have >= CAP.minTiles) finish(true, 'captured-before-kick ' + rd.have)
        }
      }, 300)
    }).catch(e => {
      const msg = String((e && e.message) || e)
      ev('socks fail: ' + msg)
      const hint = socksHint(msg)
      if (hint) hint.split('\n').forEach(l => ev(l))
      finish(false, 'socks: ' + msg)
    })
  })
}

// ========================= SELFTEST (геометрия без сервера) =========================
function makeSyntheticCaptcha(cols, rows, seed) {
  let s = seed || 12345
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff }
  const W = cols * 128, H = rows * 128
  const img = new Uint8Array(W * H)
  const BG = 34                                    // белая шерсть (base 8, shade 2)
  for (let i = 0; i < img.length; i++) img[i] = BG
  const COLORS = [118, 122, 30, 26, 114, 46, 102, 98, 54, 50, 78, 74]   // разные базы и оттенки
  const put = (x, y, v, r) => {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r) continue
      const X = x + dx, Y = y + dy
      if (X < 0 || Y < 0 || X >= W || Y >= H) continue
      img[Y * W + X] = v
    }
  }
  // пятна-шум (разноцветные)
  for (let k = 0; k < cols * rows * 6; k++) {
    put(Math.floor(rnd() * W), Math.floor(rnd() * H), COLORS[Math.floor(rnd() * COLORS.length)], 3 + Math.floor(rnd() * 12))
  }
  // «цифры»: ломаные линии разного цвета и толщины, непрерывные через границы плиток
  for (let k = 0; k < cols * rows * 3; k++) {
    let cx = 10 + rnd() * (W - 20), cy = 10 + rnd() * (H - 20)
    const col = COLORS[Math.floor(rnd() * COLORS.length)]
    const thick = 2 + Math.floor(rnd() * 3)
    for (let seg = 0; seg < 5; seg++) {
      const nx = Math.max(4, Math.min(W - 5, cx + (rnd() - 0.5) * 90))
      const ny = Math.max(4, Math.min(H - 5, cy + (rnd() - 0.5) * 90))
      const steps = Math.max(Math.abs(nx - cx), Math.abs(ny - cy)) | 0
      for (let i = 0; i <= steps; i++) put(Math.round(cx + (nx - cx) * i / steps), Math.round(cy + (ny - cy) * i / steps), col, thick)
      cx = nx; cy = ny
    }
  }
  return img
}

// синтетическая капча с настоящими цифрами (для проверки цикла обучения)
function makeSyntheticDigits(cols, rows, digits, seed) {
  let s = seed || 1
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff }
  const W = cols * 128, H = rows * 128
  const img = new Uint8Array(W * H)
  for (let i = 0; i < img.length; i++) img[i] = 34          // белая шерсть (base 8, shade 2)
  // шум только сверху/снизу, чтобы не мешать строке цифр
  const NOISE = [122, 30, 46, 98, 74]
  for (let k = 0; k < 24; k++) {
    const cx = Math.floor(rnd() * W)
    const cy = rnd() < 0.5 ? Math.floor(rnd() * H * 0.18) : Math.floor(H * 0.82 + rnd() * H * 0.18)
    const r = 3 + Math.floor(rnd() * 7)
    const v = NOISE[Math.floor(rnd() * NOISE.length)]
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) {
      if (x * x + y * y > r * r) continue
      const X = cx + x, Y = cy + y
      if (X >= 0 && Y >= 0 && X < W && Y < H) img[Y * W + X] = v
    }
  }
  // масштаб так, чтобы все цифры влезли по ширине И высоте (и не касались границ плиток)
  const n = digits.length
  const scH = Math.floor(H * 0.42 / 7)
  const scW = Math.floor((W * 0.86) / (n * 5 + (n - 1) * 1.15))
  const sc = Math.max(6, Math.min(scH, scW))
  const gap = Math.max(sc, Math.floor(sc * 1.15))
  const dw = 5 * sc
  const x0 = Math.floor((W - (n * dw + (n - 1) * gap)) / 2)
  const y0 = Math.floor((H - 7 * sc) / 2)
  const centers = []
  digits.split('').forEach((d, i) => {
    const pat = DIGITS[d]
    const ox = x0 + i * (dw + gap)
    centers.push({ x: ox + dw / 2, digit: d })
    if (!pat) return
    for (let y = 0; y < 7; y++) for (let x = 0; x < 5; x++) {
      if (!pat[y][x]) continue
      for (let dy = 0; dy < sc; dy++) for (let dx = 0; dx < sc; dx++) {
        const X = ox + x * sc + dx, Y = y0 + y * sc + dy
        if (X >= 0 && Y >= 0 && X < W && Y < H) img[Y * W + X] = 118   // чёрная шерсть (base 29, shade 2)
      }
    }
  })
  return { img, W, H, centers }
}

// собрать из картинки «снапшот раунда»: плитки на стене + рамки + точка обзора
function makeWallSnapshot(img, W, H, opts) {
  opts = opts || {}
  const cols = W / 128, rows = H / 128
  const axis = opts.axis || 'z'
  const viewSide = opts.viewSide || -1
  const OX = opts.ox || 200, OY = opts.oy || 70, OZ = opts.oz || 300
  const maps = new Map()
  const frames = []
  let id = opts.id0 || 700
  const hAscExpected = axis === 'z' ? (viewSide > 0) : (viewSide < 0)
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const tile = new Uint8Array(16384)
    for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) tile[y * 128 + x] = img[(r * 128 + y) * W + c * 128 + x]
    const q = opts.rots ? ((r * 2 + c + id) % 4) : 0
    maps.set(id, rotQ(tile, (4 - q) % 4))
    const ni = hAscExpected ? c : cols - 1 - c
    const pos = axis === 'z'
      ? { x: OX + 0.5 + ni, y: OY + 0.5 - r, z: OZ + viewSide * 0.0625 }
      : { x: OZ + viewSide * 0.0625, y: OY + 0.5 - r, z: OX + 0.5 + ni }
    frames.push({ id, x: pos.x, y: pos.y, z: pos.z, mapId: id, rotation: q, yaw: axis === 'z' ? (viewSide < 0 ? 0 : Math.PI) : (viewSide < 0 ? -Math.PI / 2 : Math.PI / 2) })
    id++
  }
  const plane = axis === 'z' ? frames[0].z : frames[0].x
  const view = opts.view || (axis === 'z'
    ? { x: OX + 2, y: OY, z: plane + viewSide * 5, yaw: viewSide < 0 ? 0 : Math.PI, pitch: 0 }
    : { x: plane + viewSide * 5, y: OY, z: OX + 2, yaw: viewSide < 0 ? -Math.PI / 2 : Math.PI / 2, pitch: 0 })
  return { maps, frames, chats: ['[chat] BotFilter >> Введите номер с картинки в чат'], events: ['selftest'], view, metaDump: [] }
}

async function selftest() {
  const learnWas = LEARN_DIR
  LEARN_DIR = path.join(__dirname, 'records', 'selftest_learn')
  try { fs.rmSync(LEARN_DIR, { recursive: true, force: true }) } catch (e) {}
  console.log('=== SELFTEST v3.13.0: геометрия сборки ===')
  let fails = 0
  // сначала — чистая проверка правила «с какой стороны смотрим → где лево»
  const hAscCases = [
    { axis: 'z', plane: 300, view: { x: 0, y: 70, z: 295 }, want: false, name: 'z-стена, бот с -z (смотрит на юг): слева большие x' },
    { axis: 'z', plane: 300, view: { x: 0, y: 70, z: 305 }, want: true, name: 'z-стена, бот с +z (смотрит на север): слева меньшие x' },
    { axis: 'x', plane: 300, view: { x: 295, y: 70, z: 0 }, want: true, name: 'x-стена, бот с -x (смотрит на восток): слева меньшие z' },
    { axis: 'x', plane: 300, view: { x: 305, y: 70, z: 0 }, want: false, name: 'x-стена, бот с +x (смотрит на запад): слева большие z' }
  ]
  console.log('--- правило стороны обзора (viewpointHAsc) ---')
  for (const hc of hAscCases) {
    const grid = { wall: { axis: hc.axis, value: hc.plane } }
    const got = viewpointHAsc(grid, hc.view)
    const ok = got === hc.want
    if (!ok) fails++
    console.log('  ' + (ok ? '✅' : '❌') + ' ' + hc.name + ' → hAsc=' + got + (ok ? '' : ' (ожидалось ' + hc.want + ')'))
  }

  console.log('--- сквозная сборка синтетической стены ---')
  const cases = [
    { cols: 3, rows: 2, axis: 'z', viewSide: -1, rots: true, name: 'z-стена 3×2, бот с -z, повороты' },
    { cols: 4, rows: 3, axis: 'z', viewSide: +1, rots: true, name: 'z-стена 4×3, бот с +z, повороты' },
    { cols: 2, rows: 3, axis: 'x', viewSide: -1, rots: true, name: 'x-стена 2×3, бот с -x, повороты' },
    { cols: 3, rows: 3, axis: 'z', viewSide: -1, rots: false, name: 'z-стена 3×3, без поворотов' },
    { cols: 4, rows: 2, axis: 'z', viewSide: -1, rots: true, name: 'z-стена 4×2, повороты (зеркальный кейс)' },
    // раскладка согласована с точкой обзора: должна выбираться ориентация 'view'
    { cols: 3, rows: 2, axis: 'z', viewSide: -1, rots: true, viewConsistent: true, wantOri: 'view', name: 'z-стена 3×2, раскладка «как видит бот с -z»' },
    { cols: 4, rows: 2, axis: 'x', viewSide: +1, rots: true, viewConsistent: true, wantOri: 'view', name: 'x-стена 4×2, раскладка «как видит бот с +x»' }
  ]
  for (const cs of cases) {
    const orig = makeSyntheticCaptcha(cs.cols, cs.rows, 7777 + cs.cols * 31 + cs.rows * 7)
    const W = cs.cols * 128, H = cs.rows * 128
    const tiles = new Map()
    const frames = []
    let id = 100
    for (let r = 0; r < cs.rows; r++) for (let c = 0; c < cs.cols; c++) {
      const tile = new Uint8Array(16384)
      for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) tile[y * 128 + x] = orig[(r * 128 + y) * W + c * 128 + x]
      const q = cs.rots ? ((r * 3 + c * 2 + id) % 4) : 0
      // сервер хранит карту «до поворота рамки»: mapData = rotQ(tile, -q)
      tiles.set(id, rotQ(tile, (4 - q) % 4))
      // куда физически встанет плитка с колонкой c изображения
      const hAscExpected = cs.axis === 'z' ? (cs.viewSide > 0) : (cs.viewSide < 0)
      const ni = cs.viewConsistent ? (hAscExpected ? c : cs.cols - 1 - c) : c
      const pos = cs.axis === 'z'
        ? { x: 200.5 + ni, y: 70.5 - r, z: 300 + cs.viewSide * 0.0625 }
        : { x: 300 + cs.viewSide * 0.0625, y: 70.5 - r, z: 200.5 + ni }
      frames.push({ id: id, x: pos.x, y: pos.y, z: pos.z, mapId: id, rotation: q })
      id++
    }
    const planeVal = cs.axis === 'z' ? frames[0].z : frames[0].x
    const view = cs.axis === 'z'
      ? { x: 202, y: 70, z: planeVal + cs.viewSide * 5, yaw: cs.viewSide < 0 ? 0 : Math.PI }
      : { x: planeVal + cs.viewSide * 5, y: 70, z: 202, yaw: cs.viewSide < 0 ? -Math.PI / 2 : Math.PI / 2 }
    const wall = { axis: cs.axis, value: planeVal, frames, tag: cs.axis + Math.round(planeVal) }
    const asm = assembleWallSmart(wall, tiles, view, {})
    if (!asm) { console.log('  ❌ ' + cs.name + ': не собралось'); fails++; continue }
    let diff = 0
    for (let i = 0; i < orig.length; i++) if (orig[i] !== asm.data[i]) diff++
    const pct = (100 * diff / orig.length)
    const okpct = pct < 0.5
    const okOri = !cs.wantOri || asm.ori.tag === cs.wantOri
    console.log('  ' + (okpct && okOri ? '✅' : '❌') + ' ' + cs.name +
      ' → ori=' + asm.ori.tag + ' hAsc=' + asm.ori.hAsc + ' rot=' + asm.rotRule +
      ' perm=' + asm.permUsed + ' seam=' + asm.seamCost + ' placed=' + asm.placed + '/' + asm.grid.total +
      ' расхождений=' + pct.toFixed(3) + '%' + (okOri ? '' : ' [ОРИЕНТАЦИЯ НЕ ТА: ждали ' + cs.wantOri + ']'))
    if (!okpct || !okOri) {
      fails++
      try {
        const d = path.join(__dirname, 'records', 'selftest')
        fs.mkdirSync(d, { recursive: true })
        fs.writeFileSync(path.join(d, cs.name.replace(/[^\w\-]+/g, '_') + '_expected.png'), colorPng(orig, W, H, 1))
        fs.writeFileSync(path.join(d, cs.name.replace(/[^\w\-]+/g, '_') + '_got.png'), colorPng(asm.data, asm.W, asm.H, 1))
      } catch (e) {}
    }
  }
  // ---- стресс: сервер НЕ прислал Rotation (в метаданных 0), плитки реально повёрнуты ----
  console.log('--- стресс-кейсы ---')
  {
    const cols = 3, rows = 2, viewSide = -1
    const orig = makeSyntheticCaptcha(cols, rows, 424242)
    const W = cols * 128
    const tiles = new Map(), frames = []
    let id = 300
    const hAscExpected = viewSide > 0
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const tile = new Uint8Array(16384)
      for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) tile[y * 128 + x] = orig[(r * 128 + y) * W + c * 128 + x]
      const q = (r + c * 2 + 1) % 4
      tiles.set(id, rotQ(tile, (4 - q) % 4))
      const ni = hAscExpected ? c : cols - 1 - c
      frames.push({ id, x: 200.5 + ni, y: 70.5 - r, z: 300 + viewSide * 0.0625, mapId: id, rotation: 0 })
      id++
    }
    const view = { x: 202, y: 70, z: 300 + viewSide * 5, yaw: 0 }
    const wall = { axis: 'z', value: frames[0].z, frames, tag: 'z300' }
    const asm = assembleWallSmart(wall, tiles, view, {})
    let diff = 0
    if (asm) for (let i = 0; i < orig.length; i++) if (orig[i] !== asm.data[i]) diff++
    const pct = asm ? 100 * diff / orig.length : 100
    const ok = !!asm && pct < 0.5
    if (!ok) fails++
    console.log('  ' + (ok ? '\u2705' : '\u274c') + ' Rotation в метаданных нет (все 0) \u2192 ' +
      (asm ? 'rot=' + asm.rotRule + ' seam=' + asm.seamCost + ' расхождений=' + pct.toFixed(3) + '%' : 'не собралось'))
  }

  // ---- стресс: одна плитка не пришла (дырка в сетке) ----
  {
    const cols = 3, rows = 3, viewSide = -1
    const orig = makeSyntheticCaptcha(cols, rows, 999111)
    const W = cols * 128
    const tiles = new Map(), frames = []
    let id = 400
    const holeIdx = 4 // центральная плитка
    let k = 0
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++, k++) {
      const tile = new Uint8Array(16384)
      for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) tile[y * 128 + x] = orig[(r * 128 + y) * W + c * 128 + x]
      if (k !== holeIdx) tiles.set(id, tile)
      frames.push({ id, x: 200.5 + (cols - 1 - c), y: 70.5 - r, z: 300 + viewSide * 0.0625, mapId: id, rotation: 0 })
      id++
    }
    // как в saveRecord: в стену попадают только рамки с пришедшими данными
    const linked = frames.filter(f => tiles.has(f.mapId))
    const view = { x: 202, y: 70, z: 300 + viewSide * 5, yaw: 0 }
    const wall = { axis: 'z', value: frames[0].z, frames: linked, tag: 'z300' }
    const asm = assembleWallSmart(wall, tiles, view, {})
    let badCells = 0
    if (asm) {
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        let same = true
        for (let y = 0; y < 128 && same; y++) for (let x = 0; x < 128; x++) {
          if (orig[(r * 128 + y) * W + c * 128 + x] !== asm.data[(r * 128 + y) * asm.W + c * 128 + x]) { same = false; break }
        }
        if (!same) badCells++
      }
    }
    const ok = !!asm && asm.grid.cols === 3 && asm.grid.rows === 3 && asm.placed === 8 && asm.missing === 1 && badCells === 1
    if (!ok) fails++
    console.log('  ' + (ok ? '\u2705' : '\u274c') + ' нет данных одной плитки \u2192 ' +
      (asm ? 'сетка=' + asm.grid.cols + '\u00d7' + asm.grid.rows + ' placed=' + asm.placed + ' missing=' + asm.missing +
        ' битых ячеек=' + badCells + ' (ожидалась 1 \u2014 сама дырка)' : 'не собралось'))
  }

  // ---- разбор метаданных item_frame (все известные формы протокола) ----
  console.log('--- разбор map_id / Rotation из метаданных ---')
  const metaCases = [
    {
      name: '1.21.1 сырой пакет nmp (type — число, data components)',
      meta: [
        { key: 0, type: 0, value: 0 }, { key: 1, type: 1, value: 300 },
        { key: 8, type: 7, value: { present: true, itemCount: 1, itemId: 638, addedComponentCount: 1, removedComponentCount: 0, components: [{ type: 'map_id', data: 17 }], removeComponents: [] } },
        { key: 9, type: 1, value: 2 }
      ], wantMap: 17, wantRot: 2
    },
    {
      name: '1.21.x mineflayer entity.metadata (объект, minecraft:map_id, data-объект)',
      meta: { 0: 0, 1: 300, 8: { present: true, itemCount: 1, itemId: 638, components: [{ type: 'minecraft:map_id', data: { value: 5 } }] }, 9: 1 },
      wantMap: 5, wantRot: 1
    },
    {
      name: '1.16 slot через blockId/itemDamage',
      meta: [{ key: 8, type: 6, value: { blockId: 358, itemCount: 1, itemDamage: 42, nbtData: null } }, { key: 9, type: 1, value: 3 }],
      wantMap: 42, wantRot: 3
    },
    {
      name: '1.17–1.20.4 slot с NBT-тегом map',
      meta: [{ key: 8, type: 'slot', value: { itemId: 638, itemCount: 1, nbtData: { type: 'compound', value: { map: { type: 'int', value: 99 } } } } }, { key: 9, type: 'varint', value: 0 }],
      wantMap: 99, wantRot: 0
    },
    {
      name: 'пустая рамка (нет карты)',
      meta: [{ key: 8, type: 7, value: { present: false, itemCount: 0 } }, { key: 9, type: 1, value: 0 }],
      wantMap: null, wantRot: 0
    }
  ]
  for (const mc of metaCases) {
    const got = extractFrameInfo(mc.meta) || {}
    const okMap = (got.mapId === null || got.mapId === undefined) ? mc.wantMap === null : got.mapId === mc.wantMap
    const okRot = (got.rotation === null || got.rotation === undefined) ? mc.wantRot === null : got.rotation === mc.wantRot
    const ok = okMap && okRot
    if (!ok) fails++
    console.log('  ' + (ok ? '✅' : '❌') + ' ' + mc.name + ' → mapId=' + (got.mapId === undefined ? 'undef' : got.mapId) +
      ' rotation=' + (got.rotation === undefined ? 'undef' : got.rotation) +
      (ok ? '' : ' (ожидалось mapId=' + mc.wantMap + ' rotation=' + mc.wantRot + ')'))
  }

  // ---- сквозной прогон saveRecord (как после живого раунда) ----
  console.log('--- сквозной прогон saveRecord ---')
  {
    const cols = 4, rows = 3
    const orig = makeSyntheticCaptcha(cols, rows, 31337)
    const W = cols * 128
    const maps = new Map()
    const frames = []
    let id = 500
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const tile = new Uint8Array(16384)
      for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) tile[y * 128 + x] = orig[(r * 128 + y) * W + c * 128 + x]
      const q = (r * 2 + c) % 4
      maps.set(id, rotQ(tile, (4 - q) % 4))
      frames.push({ id, x: 200.5 + (cols - 1 - c), y: 70.5 - r, z: 299.9375, mapId: id, rotation: q })
      id++
    }
    const view = { x: 202, y: 70, z: 294.9, yaw: 0, pitch: 0 }
    const outDir = path.join(REC_ROOT || __dirname, 'selftest_e2e')
    const snap = { maps, frames, chats: ['[chat] Введите номер с картинки'], events: ['selftest'], view, metaDump: [] }
    let rec = null, err = null
    try { rec = await saveRecord(outDir, snap, 'SELFTEST', null) } catch (e) { err = e }
    if (err) { console.log('  \u274c saveRecord бросил: ' + err.message); fails++ }
    else if (!rec) { console.log('  \u274c saveRecord вернул null'); fails++ }
    else {
      let diff = 0
      try {
        const got = fs.readFileSync(path.join(outDir, 'ORIGINAL_raw.bin'))
        for (let i = 0; i < orig.length; i++) if (got[i] !== orig[i]) diff++
      } catch (e) { diff = orig.length }
      const pct = 100 * diff / orig.length
      const filesOk = ['ORIGINAL_CAPTCHA.png', 'ORIGINAL_CAPTCHA_x1.png', 'layout.json', 'assembly_debug.json', 'ORIGINAL_raw.bin']
        .every(f => fs.existsSync(path.join(outDir, f)))
      // быстрый (light) режим: тяжёлых отладочных файлов нет, но картинка для Telegram и raw — есть
      const lightDir = outDir + '_light'
      await saveRecord(lightDir, snap, 'SELFTEST-LIGHT', null, { light: true })
      const lightOk = ['ORIGINAL_CAPTCHA_x1.png', 'ORIGINAL_raw.bin', 'digits.json', 'assembly_debug.json', 'walls_debug.json']
        .every(f => fs.existsSync(path.join(lightDir, f))) &&
        !fs.existsSync(path.join(lightDir, 'variants')) && !fs.existsSync(path.join(lightDir, 'tiles')) &&
        fs.readFileSync(path.join(lightDir, 'ORIGINAL_raw.bin')).equals(fs.readFileSync(path.join(outDir, 'ORIGINAL_raw.bin')))
      const ok = pct < 0.5 && filesOk && lightOk && rec.tilesCount === cols * rows
      if (!ok) fails++
      console.log('  ' + (ok ? '\u2705' : '\u274c') + ' saveRecord ' + rec.cols + '\u00d7' + rec.rows +
        ' tiles=' + rec.tilesCount + '/' + rec.tilesExpected + ' ori=' + rec.ori + ' rot=' + rec.rotRule +
        (rec.permUsed ? ' PERM!' : '') + ' seam=' + rec.seamCost +
        ' файлы=' + (filesOk ? 'все' : 'НЕ ВСЕ') +
        ' light-режим=' + (lightOk ? 'ок (raw совпадает, тяжёлое не пишем)' : 'СБОЙ') +
        ' расхождений=' + pct.toFixed(3) + '%')
    }
  }

  // ---- УМНАЯ СЕГМЕНТАЦИЯ на «трудных» фонах (ровно 5 цифр) ----
  console.log('--- умная сегментация: ровный/слипшийся/инверсный/блочный/шум/враждебный фон ---')
  {
    const segCase = (mode, seed) => {
      const digits = '48152'
      let s = seed
      const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff }
      const W = 512, H = 384
      const img = new Uint8Array(W * H)
      const DC = 118
      const PAL = [122, 30, 46, 98, 74, 34, 26, 54, 50, 102, 86, 90, 110, 114]
      const use = mode === 'adv' ? PAL.concat([DC]) : PAL
      if (mode === 'noise' || mode === 'adv') for (let i = 0; i < img.length; i++) img[i] = use[Math.floor(rnd() * use.length)]
      else if (mode === 'blocks') { for (let y = 0; y < H; y += 8) for (let x = 0; x < W; x += 8) { const c = use[Math.floor(rnd() * use.length)]; for (let dy = 0; dy < 8; dy++) for (let dx = 0; dx < 8; dx++) img[(y + dy) * W + x + dx] = c } }
      else img.fill(mode === 'white' ? DC : 34)
      const sc = 17, gap = mode === 'touch' ? 0 : 12
      const total = digits.length * (5 * sc) + (digits.length - 1) * gap
      const x0 = Math.floor((W - total) / 2), y0 = Math.floor(H / 2 - 3.5 * sc)
      const truth = []
      digits.split('').forEach((d, i) => {
        const p = DIGITS[d]; let t = null
        for (let y = 0; y < 7; y++) for (let x = 0; x < 5; x++) {
          if (p[y][x] !== 1) continue
          for (let dy = 0; dy < sc; dy++) for (let dx = 0; dx < sc; dx++) {
            const X = x0 + i * (5 * sc + gap) + x * sc + dx, Y = y0 + y * sc + dy
            if (X < 0 || Y < 0 || X >= W || Y >= H) continue
            img[Y * W + X] = mode === 'white' ? 34 : DC
            if (!t) t = { mnX: X, mxX: X, mnY: Y, mxY: Y }
            else { if (X < t.mnX) t.mnX = X; if (X > t.mxX) t.mxX = X; if (Y < t.mnY) t.mnY = Y; if (Y > t.mxY) t.mxY = Y }
          }
        }
        truth.push(t)
      })
      const r = DIG.extractDigitsSmart(img, W, H, 5, {})
      let worst = 999
      if (r.glyphs.length === 5) {
        worst = 0
        r.glyphs.forEach((g, i) => {
          const t = truth[i]; if (!t) return
          worst = Math.max(worst, Math.abs(g.bbox.mnX - t.mnX), Math.abs(g.bbox.mxX - t.mxX), Math.abs(g.bbox.mnY - t.mnY), Math.abs(g.bbox.mxY - t.mxY))
        })
      }
      const tol = (mode === 'adv' || mode === 'noise') ? 14 : 3
      return { mode, ok: r.glyphs.length === 5 && worst <= tol, worst, tol, strategy: r.strategy, score: r.score, tried: r.tried, ms: r.ms }
    }
    let segFails = 0
    for (const mode of ['plain', 'touch', 'white', 'blocks', 'noise', 'adv']) {
      const t0 = Date.now()
      const r = segCase(mode, 4242 + mode.length)
      r.ms = Date.now() - t0
      if (!r.ok) segFails++
      console.log('  ' + (r.ok ? '\u2705' : '\u274c') + ' ' + r.mode.padEnd(7) + ' маска=' + String(r.strategy).padEnd(18) +
        ' балл=' + String(r.score).padEnd(7) + ' стратегий=' + r.tried + ' за ' + r.ms + 'мс' +
        ' | отклонение рамок=' + r.worst + 'px (допуск ' + r.tol + 'px)')
    }
    if (segFails) fails += segFails
  }

  // ---- ЦИКЛ ОБУЧЕНИЯ: разметили несколько раундов -> распознаём новый ----
  console.log('--- цикл обучения цифр (разметка -> распознавание) ---')
  {
    const cols = 4, rows = 3
    const train = ['48152', '16237', '90745']
    const test = ['37061', '15902']
    let labeledTotal = 0
    const problems = []
    // чистая база и очередь: тестируем именно цикл обучения
    try { fs.rmSync(LEARN_DIR, { recursive: true, force: true }) } catch (e) {}
    for (let i = 0; i < train.length; i++) {
      const d = train[i]
      const g = makeSyntheticDigits(cols, rows, d, 1234 + i * 977)
      const snap = makeWallSnapshot(g.img, g.W, g.H, { rots: true, id0: 700 + i * 100 })
      const outDir = path.join(REC_ROOT || __dirname, 'selftest_learn', 'r' + (i + 1))
      const rec = await saveRecord(outDir, snap, 'LEARN' + (i + 1), null)
      if (!rec) { problems.push('раунд ' + d + ' не собрался'); continue }
      // «размечаем» очередь так же, как это делает человек в label.js:
      // сопоставляем каждый глиф с ближайшим центром настоящей цифры
      const q = new DIG.LabelQueue(LEARN_DIR)
      const store = new DIG.GlyphStore(LEARN_DIR)
      const items = q.items.slice()
      let done = 0
      for (const it of items) {
        const cx = it.bbox ? it.bbox.mnX + it.bbox.w / 2 : -1
        let bc = null, bd = 1e9
        for (const cn of g.centers) { const dd = Math.abs(cn.x - cx); if (dd < bd) { bd = dd; bc = cn } }
        if (!bc || bd > 40) { problems.push('раунд ' + d + ': глиф x=' + Math.round(cx) + ' не сопоставлен ни с одной цифрой'); continue }
        store.add(Number(bc.digit), DIG.b64ToF32(it.f), { src: 'selftest#' + it.id })
        q.remove(it.id)
        labeledTotal++; done++
      }
      q.save()
      if (done !== d.length) problems.push('раунд ' + d + ': размечено ' + done + ' из ' + d.length)
    }
    let okTests = 0
    for (let i = 0; i < test.length; i++) {
      const d = test[i]
      const g = makeSyntheticDigits(cols, rows, d, 909090 + i * 613)
      const snap = makeWallSnapshot(g.img, g.W, g.H, { rots: true, viewSide: +1, id0: 1700 + i * 100 })
      const outDir = path.join(REC_ROOT || __dirname, 'selftest_learn', 't' + (i + 1))
      const rec = await saveRecord(outDir, snap, 'TEST' + (i + 1), null)
      const got = rec ? rec.prediction : '(нет)'
      const ok = got === d
      if (ok) okTests++
      else problems.push('ожидали "' + d + '" получили "' + got + '"' + (rec ? ' сырое="' + rec.digitsAll + '"' : ''))
      console.log('  ' + (ok ? '\u2705' : '\u274c') + ' тест "' + d + '" \u2192 распознано "' + got + '"' +
        (rec ? ' (глифов ' + rec.glyphCount + ', неуверенных ' + rec.needLabel + ')' : ''))
    }
    const ok = okTests === test.length && !problems.length
    if (!ok) fails++
    console.log('  ' + (ok ? '\u2705' : '\u274c') + ' размечено вручную: ' + labeledTotal + ' глифов (по ' +
      Math.round(labeledTotal / 10 * 10) / 10 + ' на цифру) \u2192 тестов: ' + okTests + '/' + test.length +
      (problems.length ? ' | проблемы: ' + problems.join('; ') : ''))
  }

  // ---- СЦЕНАРИЙ РАУНДА 6: две стены рядом, надо выбрать ту, на которую смотрит бот ----
  console.log('--- выбор настоящей стены среди соседей (регрессия раунда 6) ---')
  {
    const cols = 4, rows = 3
    const trueDigits = '42715', decoyDigits = '99331'
    const gA = makeSyntheticDigits(cols, rows, trueDigits, 5150)
    const gB = makeSyntheticDigits(cols, rows, decoyDigits, 7777)
    const view = { x: 202, y: 70, z: 294.9, yaw: 0, pitch: 0 }   // бот смотрит на юг (+z)
    // настоящая стена: прямо перед ботом (z=299.94)
    const A = makeWallSnapshot(gA.img, gA.W, gA.H, { axis: 'z', viewSide: -1, rots: true, id0: 2000, ox: 200, oy: 70, oz: 300, view })
    // соседняя стена: сбоку и дальше (перпендикулярная, x=210)
    const B = makeWallSnapshot(gB.img, gB.W, gB.H, { axis: 'x', viewSide: +1, rots: true, id0: 2100, ox: 300, oy: 70, oz: 210, view })
    const maps = new Map([...A.maps, ...B.maps])
    const frames = A.frames.concat(B.frames)
    const snap = { maps, frames, chats: [], events: ['selftest'], view, metaDump: [] }
    const cands = detectWalls(frames.filter(f => maps.has(f.mapId)), wallMinFrames(frames.length))
    const outDir = path.join(REC_ROOT || __dirname, 'selftest_learn', 'walls')
    const rec = await saveRecord(outDir, snap, 'WALLS', null)
    const expectTag = 'z300'
    const okWall = !!rec && rec.wall === expectTag
    const okDigits = !!rec && rec.prediction === trueDigits
    const okNoArtifact = cands.every(w => w.frames.length === 12)     // никаких «сквозных» 6-рамочных псевдостен
    const ok = okWall && okDigits && okNoArtifact
    if (!ok) fails++
    console.log('  ' + (ok ? '\u2705' : '\u274c') + ' кандидатов=' + cands.map(w => w.tag + '(' + w.frames.length + ')').join(',') +
      ' | выбрана=' + (rec ? rec.wall : 'нет') + ' (ждали ' + expectTag + ')' +
      ' | цифры="' + (rec ? rec.digits : '') + '" (ждали "' + trueDigits + '")' +
      ' | сквозных артефактов: ' + (okNoArtifact ? 'нет' : 'ЕСТЬ') +
      (rec ? ' | счёт: ' + rec.candidates.map(c => c.wall + '=' + c.score).join(', ') : ''))
  }

  // ---- РЕГРЕССИЯ из вашего лога: бот стоит вплотную к капче, но yaw смотрит назад (dot≈-1) ----
  console.log('--- ближайшая стена выигрывает, даже если бот смотрит не на неё ---')
  {
    const cols = 4, rows = 3
    const gA = makeSyntheticDigits(cols, rows, '53091', 2468)
    const gB = makeSyntheticDigits(cols, rows, '1111', 1357)
    // капча вплотную сзади (dist≈2.5, dot≈-1), конкурент — далеко впереди (dist≈60, dot≈+1)
    const view = { x: 202, y: 70, z: 305, yaw: 0, pitch: 0 }   // бот смотрит на +z (на юг)
    // A — капча: вплотную, но ЗА спиной (dot ≈ -1).  B — соседняя: далеко ВПЕРЕДИ (dot ≈ +1)
    const A = makeWallSnapshot(gA.img, gA.W, gA.H, { axis: 'z', viewSide: +1, rots: true, id0: 4000, ox: 200, oy: 70, oz: 302, view })
    const B = makeWallSnapshot(gB.img, gB.W, gB.H, { axis: 'z', viewSide: -1, rots: true, id0: 4100, ox: 200, oy: 70, oz: 365, view })
    const maps = new Map([...A.maps, ...B.maps])
    const snap = { maps, frames: A.frames.concat(B.frames), chats: [], events: ['selftest'], view, metaDump: [] }
    const outDir = path.join(REC_ROOT || __dirname, 'selftest_learn', 'behind')
    const rec = await saveRecord(outDir, snap, 'BEHIND', null)
    const ok = !!rec && rec.wall === 'z302' && rec.prediction === '53091' && rec.dot < 0
    if (!ok) fails++
    console.log('  ' + (ok ? '\u2705' : '\u274c') + ' выбрана=' + (rec ? rec.wall : 'нет') + ' (ждали z302, dot<0)' +
      ' dot=' + (rec ? rec.dot.toFixed(2) : '?') + ' dist=' + (rec ? rec.dist : '?') +
      ' предсказание="' + (rec ? rec.prediction : '') + '" (ждали "53091")' +
      (rec ? ' | счёт: ' + rec.candidates.map(c => c.wall + '=' + c.score).join(', ') : ''))
  }

  // ---- YOLO API: клиент, оба формата ответа, мусорные ответы, fallback ----
  console.log('--- YOLO API (мок-сервер, без интернета) ---')
  {
    const http = require('http')
    const PORT = 0
    const srv = http.createServer((rq, rs) => {
      const b = []
      rq.on('data', c => b.push(c))
      rq.on('end', () => {
        const buf = Buffer.concat(b), s = buf.toString('latin1')
        const j = o => { rs.writeHead(200, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify(o)) }
        const field = (s.match(/name="([^"]+)"; filename=/) || [])[1] || null
        if (rq.url.indexOf('/recognize') === 0) return j({ success: true, answer: '48152', field, conf: 0.6, ms: 90 })
        if (rq.url.indexOf('/solve') === 0) return j({ result: '13579' })
        if (rq.url.indexOf('/html') === 0) { rs.writeHead(200, { 'Content-Type': 'text/html' }); rs.end('<html><body>404</body></html>'); return }
        if (rq.url.indexOf('/bad') === 0) return j({ success: false, error: 'no boxes' })
        j({ success: false, error: 'route?' })
      })
    })
    await new Promise(r => srv.listen(PORT, '127.0.0.1', r))
    const port = srv.address().port
    const savedUrls = YOLO.urls.slice(), savedAlive = yoloAlive
    const g = makeSyntheticDigits(4, 3, '48152', 555)
    const png = colorPng(g.img, g.W, g.H, 1)
    const checks = []

    yoloReset(); YOLO.urls = ['http://127.0.0.1:' + port + '/recognize']
    let r1 = await yoloRecognize(png, 'st1')
    checks.push(['формат {success,answer} + поле image', !!r1 && r1.digits === '48152' && r1.field === 'image'])

    yoloReset(); YOLO.urls = ['http://127.0.0.1:' + port + '/solve']
    let r2 = await yoloRecognize(png, 'st2')
    checks.push(['формат {result} (Flask из треда)', !!r2 && r2.digits === '13579'])

    yoloReset(); YOLO.urls = ['http://127.0.0.1:' + port + '/html']
    let r3 = await yoloRecognize(png, 'st3')
    checks.push(['HTML-страница НЕ принимается за цифры', r3 === null])

    yoloReset(); YOLO.urls = ['http://127.0.0.1:' + port + '/bad']
    let r4 = await yoloRecognize(png, 'st4')
    checks.push(['success:false -> нет ответа', r4 === null])

    yoloReset(); YOLO.urls = ['http://127.0.0.1:1/recognize', 'http://127.0.0.1:' + port + '/recognize']
    let r5 = await yoloRecognize(png, 'st5')
    checks.push(['fallback на следующий URL', !!r5 && r5.digits === '48152'])

    srv.close()
    YOLO.urls = savedUrls
    yoloReset()
    for (const [name, ok] of checks) { if (!ok) fails++; console.log('  ' + (ok ? '\u2705' : '\u274c') + ' ' + name) }
  }

  // ---- TELEGRAM-СЕССИЯ: обучение до N совпадений подряд (локальный мок, без интернета) ----
  console.log('--- Telegram-сессия: предсказание + обучение до N совпадений подряд ---')
  {
    const http = require('http')
    const truth = ['12345', '54321', '11223', '45454', '33221', '51423', '22334', '44551']
    let pending = [], photos = 0, replyNo = 0, msgId = 500
    const texts = []
    const srv = http.createServer((rq, rs) => {
      const b = []
      rq.on('data', c => b.push(c))
      rq.on('end', () => {
        const buf = Buffer.concat(b), s = buf.toString('latin1')
        const m = rq.url.split('/').pop().split('?')[0]
        const j = o => { rs.writeHead(200, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify(o)) }
        if (m === 'getMe') return j({ ok: true, result: { id: 1, username: 'selftest_bot' } })
        if (m === 'sendMessage') { let p = {}; try { p = JSON.parse(buf.toString('utf8')) } catch (e) {}; texts.push(p.text || ''); return j({ ok: true, result: { message_id: ++msgId } }) }
        if (m === 'sendPhoto') {
          photos++
          const i = s.indexOf('name="caption"')
          let cap = ''
          if (i >= 0) { const a = s.indexOf('\r\n\r\n', i) + 4, e2 = s.indexOf('\r\n--', a); cap = buf.slice(a, e2).toString('utf8') }
          j({ ok: true, result: { message_id: ++msgId } })
          // отвечаем только на фото САМОЙ капчи (не на полосу глифов)
          if (cap.indexOf('\u{1F5BC}') !== 0) return
          const rm = cap.match(/[Рр]аунд (\d+)/)
          const rnd = rm ? Number(rm[1]) : photos
          pending.push({ update_id: 5000 + (++replyNo), message: { message_id: ++msgId, chat: { id: 1 }, text: truth[(rnd - 1) % truth.length], date: 0 } })
          return
        }
        if (m === 'getUpdates') {
          let p = {}; try { p = JSON.parse(buf.toString('utf8')) } catch (e) {}
          if (typeof p.offset === 'number' && p.offset > 0) pending = pending.filter(u => u.update_id >= p.offset)
          const out = pending.splice(0, pending.length)
          const send = () => { rs.writeHead(200, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify({ ok: true, result: out })) }
          if (out.length || p.timeout === 0) send(); else setTimeout(send, 60)
          return
        }
        j({ ok: true, result: {} })
      })
    })
    await new Promise(r => srv.listen(0, '127.0.0.1', r))
    const port = srv.address().port
    const saved = { apiUrl: TG.apiUrl, token: TG.token, chatId: TG.chatId, target: TG.targetStreak, max: TG.maxRounds, ready: TG.ready }
    TG.apiUrl = 'http://127.0.0.1:' + port; TG.token = 'SELFTEST'; TG.chatId = '1'
    TG.targetStreak = 3; TG.maxRounds = 8; TG.ready = true
    tgTransport = null
    const ctx2 = { results: [], rotationsUsed: 0, consecutiveNetFails: 0, proxyFails: 0, proxyDead: false, aborted: false, tGlobal: Date.now() }
    const fake = async r => {
      const d = truth[(r - 1) % truth.length]
      const g = makeSyntheticDigits(4, 3, d, 31337 + r * 71)
      const snap = makeWallSnapshot(g.img, g.W, g.H, { rots: true, id0: 8000 + r * 100 })
      const rec = await saveRecord(path.join(REC_ROOT || __dirname, 'selftest_learn', 'tg' + r), snap, 'TGR' + r, r)
      ctx2.results.push({ n: r, ok: !!rec, rec })
      return rec
    }
    let res = null, err = null
    const t0 = Date.now()
    try { res = await runTelegramSession(ctx2, fake) } catch (e) { err = e }
    srv.close()
    Object.assign(TG, { apiUrl: saved.apiUrl, token: saved.token, chatId: saved.chatId, targetStreak: saved.target, maxRounds: saved.max, ready: saved.ready })
    const st = res && res.st
    const ok = !err && res && res.ok && st && st.doneByStreak === true && st.bestStreak >= 3 && st.labeled >= 3 * 5 &&
      texts.some(t => t.indexOf('\u{1F393}') === 0) && photos >= 3
    if (!ok) fails++
    console.log('  ' + (ok ? '\u2705' : '\u274c') + ' сессия: ' + (err ? 'ошибка ' + err.message : (st
      ? 'раундов=' + st.rounds + ' фото=' + photos + ' совпало=' + st.matches + '/' + (st.matches + st.mismatches) +
        ' рекорд подряд=' + st.bestStreak + ' (цель ' + saved.target + ') размечено=' + st.labeled +
        ' завершено по цели=' + st.doneByStreak + ' за ' + ((Date.now() - t0) / 1000).toFixed(1) + 'с'
      : 'нет статистики')))
    if (!ok && st) console.log('     ⚠️ ожидали: doneByStreak=true, bestStreak>=' + 3 + ', размечено>=' + 15 + ', финальное сообщение 🎓')
  }

  // ============ v3.12.0: ответы человека, импорт из лога, офлайн-тюнинг ============
  console.log('--- v3.12.0: парсинг CLI-флагов (офлайн-режимы не должны включаться сами) ---')
  {
    // регрессия: argVal возвращает '' когда флага нет, поэтому проверка
    // «typeof === 'string'» давала CLI.autotune=true ВСЕГДА → обычный запуск
    // node main.js уходил бы в офлайн-тюнинг вместо сбора капчи.
    const srcSelf = fs.readFileSync(__filename, 'utf8')
    const a = srcSelf.indexOf('const ARGV = process.argv.slice(2)')
    const b = srcSelf.indexOf('\n}\n', srcSelf.indexOf('diagDir:')) + 3
    const cases = [
      { argv: [], want: { autotune: false, diag: false, importAnswers: '', apply: false } },
      { argv: ['--autotune'], want: { autotune: true } },
      { argv: ['--autotune', 'records'], want: { autotune: true, autotuneDir: 'records' } },
      { argv: ['--diag'], want: { diag: true, diagDir: '' } },
      { argv: ['--diag', 'records/round01'], want: { diag: true, diagDir: 'records/round01' } },
      { argv: ['--import-answers'], want: { importAnswers: 'log' } },
      { argv: ['--autotune', '--apply'], want: { autotune: true, apply: true } },
      { argv: ['--rounds', '5'], want: { autotune: false, diag: false, apply: false, importAnswers: '' } }
    ]
    let cliBad = 0
    for (const c of cases) {
      const CLIx = new Function('process', 'path', srcSelf.slice(a, b) + '; return CLI')(
        { argv: ['node', 'main.js'].concat(c.argv) }, path)
      for (const k in c.want) {
        const w = c.want[k], got = CLIx[k]
        const okk = (w === 'log') ? /telegram\.log$/.test(String(got)) : (got === w)
        if (!okk) { cliBad++; console.log('     ❌ ' + (c.argv.join(' ') || '(без флагов)') + ': ' + k + '=' + JSON.stringify(got) + ' (жду ' + JSON.stringify(w) + ')') }
      }
    }
    if (cliBad) fails++
    console.log('  ' + (cliBad ? '\u274c' : '\u2705') + ' CLI: ' + cases.length + ' кейсов, расхождений ' + cliBad)
  }

  console.log('--- v3.12.0: команды с аргументами («/glyphs 82502» из лога 13:12) ---')
  {
    // регрессия: сообщение «/glyphs 82502» не находило обработчик и молча
    // проваливалось в «пришлите ровно 5 цифр» — человек трижды слал /glyphs
    const botName = 'mainccbot'
    const parse = t => {
      const low = t.toLowerCase()
      const m = low.match(/^\/([a-z]+)(@[a-z0-9_]+)?([\s\S]*)$/)
      return { cmd: m ? '/' + m[1] : '', ok: !!m && (!m[2] || m[2] === '@' + botName), arg: m ? String(m[3] || '').trim() : '' }
    }
    const cases = [
      { t: '/glyphs', cmd: '/glyphs', arg: '' },
      { t: '/glyphs 82502', cmd: '/glyphs', arg: '82502' },
      { t: '/glyphs@MainCCbot', cmd: '/glyphs', arg: '' },
      { t: '/diag', cmd: '/diag', arg: '' },
      { t: '/skip не вижу цифр', cmd: '/skip', arg: 'не вижу цифр' },
      { t: '/stop@MainCCbot', cmd: '/stop', arg: '' },
      { t: '82502', cmd: '', arg: '' },
      { t: '+', cmd: '', arg: '' }
    ]
    let bad = 0
    for (const c of cases) {
      const r = parse(c.t)
      const good = r.cmd === c.cmd && (c.arg === '' || r.arg === c.arg) && (c.cmd === '' || r.ok)
      if (!good) { bad++; console.log('     ❌ «' + c.t + '» → cmd="' + r.cmd + '" arg="' + r.arg + '" ok=' + r.ok) }
    }
    // цифры из аргумента должны доставаться так же, как из обычного сообщения
    const digs = '/glyphs 82502'.match(/^\/([a-z]+)(@[a-z0-9_]+)?([\s\S]*)$/)[3].replace(/[^0-9]/g, '')
    if (digs !== '82502') { bad++; console.log('     ❌ цифры из аргумента: "' + digs + '"') }
    if (bad) fails++
    console.log('  ' + (bad ? '\u274c' : '\u2705') + ' команды с аргументами: ' + cases.length + ' кейсов, ошибок ' + bad)
  }

  console.log('--- v3.12.0: разбор ответов из telegram.log ---')
  {
    const log = [
      '17:38:29 [TG] транспорт: tg-proxy(1.2.3.4:8000)',
      '17:38:34 [TG] раунд 1: фото отправлено (message_id=2777) цифр=5/5',
      '17:38:59 [TG] раунд 1: ответ «40242» (update_id=785300514)',
      '17:39:05 [TG] раунд 2: ответ «88073» (update_id=785300515)',
      '17:39:13 [TG] раунд 3: ответ «8695» (update_id=785300516)',
      '17:39:21 [TG] раунд 4: ответ «/skip» (update_id=785300517)',
      '14:04:36 [TG] транспорт: tg-proxy(1.2.3.4:8000)',
      '14:04:41 [TG] раунд 1: ответ «59131» (update_id=785300515)',
      '14:05:03 [TG] раунд 4: ответ «59209» (update_id=785300518)'
    ].join('\n')
    const parsed = parseAnswersFromLog(log)
    const good = parsed.filter(p => !p.skipped)
    const replayed = parsed.filter(p => p.replayed)
    const short = parsed.filter(p => p.skipped && /не 5 цифр/.test(p.skipped))
    const ok = good.length === 3 && replayed.length === 1 && short.length === 1 &&
      good.some(g => g.round === 1 && g.answer === '40242' && g.session === 1) &&
      good.some(g => g.round === 4 && g.answer === '59209' && g.session === 2) &&
      replayed[0].round === 1 && replayed[0].session === 2
    if (!ok) fails++
    console.log('  ' + (ok ? '✅' : '❌') + ' парсер: принято ' + good.length + ' (жду 3), «призраков» ' + replayed.length +
      ' (жду 1), отброшено по длине ' + short.length + ' (жду 1), сессий ' + (parsed.length ? Math.max.apply(null, parsed.map(p => p.session)) : 0))
    if (!ok) console.log('     ⚠️ ' + JSON.stringify(parsed))
  }

  console.log('--- v3.12.0: answers.jsonl + сопоставление с каталогами ---')
  {
    const dirs = [
      { dir: '/x/round01_a1_2026-10-17T14-38-29-000Z', name: 'round01_a1_2026-10-17T14-38-29-000Z', round: 1, attempt: 1, stamp: '2026-10-17T14-38-29-000Z', t: Date.parse('2026-10-17T14:38:29Z') },
      { dir: '/x/round02_a1_2026-10-17T14-38-29-000Z', name: 'round02_a1_2026-10-17T14-38-29-000Z', round: 2, attempt: 1, stamp: '2026-10-17T14-38-29-000Z', t: Date.parse('2026-10-17T14:38:41Z') },
      { dir: '/x/round01_a1_2026-10-17T11-04-36-000Z', name: 'round01_a1_2026-10-17T11-04-36-000Z', round: 1, attempt: 1, stamp: '2026-10-17T11-04-36-000Z', t: Date.parse('2026-10-17T11:04:36Z') }
    ]
    // локальное время в логе 17:38 = UTC 14:38 (сдвиг +3ч) — парсер должен сам его найти
    const answers = [
      { round: 1, answer: '40242', sec: 17 * 3600 + 38 * 60 + 59, session: 1 },
      { round: 2, answer: '88073', sec: 17 * 3600 + 39 * 60 + 5, session: 1 }
    ]
    const mt = matchAnswersToDirs(answers, dirs)
    const ok = mt.matched.length === 2 &&
      mt.matched.some(m => m.answer.answer === '40242' && /14-38-29/.test(m.dir.name)) &&
      mt.matched.some(m => m.answer.answer === '88073' && /round02/.test(m.dir.name)) &&
      Math.abs(Math.abs(mt.offsetSec) - 3 * 3600) < 1800
    if (!ok) fails++
    console.log('  ' + (ok ? '✅' : '❌') + ' сопоставление: пар ' + mt.matched.length + '/2, сдвиг ' + Math.round(mt.offsetSec / 60) + ' мин (жду ≈180), ' +
      'каталоги: ' + mt.matched.map(m => m.dir.name.slice(0, 8)).join(','))
    if (!ok) console.log('     ⚠️ ' + JSON.stringify(mt.matched.map(m => ({ a: m.answer.answer, d: m.dir.name }))))
  }

  console.log('--- v3.12.0: штраф за равномерную нарезку + детектор «одинаковых кропов» ---')
  {
    // 1) на «плоской» картинке (шум без цифр) кропы обязаны выродиться
    const W = 512, H = 384
    let s = 4242
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff }
    const flat = new Uint8Array(W * H)
    for (let i = 0; i < flat.length; i++) flat[i] = rnd() < 0.5 ? 34 : 118
    const rFlat = DIG.extractDigitsSmart(flat, W, H, 5, {})
    const okFlat = !!rFlat && (!rFlat.glyphs.length || rFlat.degenerate === true)
    // 2) на настоящих цифрах вырождения быть не должно
    const g = makeSyntheticDigits(4, 3, '12345', 909)
    const rGood = DIG.extractDigitsSmart(g.img, g.W, g.H, 5, {})
    const okGood = !!rGood && rGood.glyphs.length === 5 && rGood.degenerate === false && rGood.sameFrac < 0.6
    // 3) равномерная нарезка штрафуется (fallback → балл ниже, чем у честной)
    const mask = new Uint8Array(W * H)
    for (let y = 100; y < 280; y++) for (let x = 40; x < 470; x++) mask[y * W + x] = 1   // сплошная полоса: ДП не найдёт 5 сегментов по чернилам
    const segFb = DIG.dpSegment(mask, W, 100, 279, 5)
    const boxesFb = DIG.tightBoxes(mask, W, segFb.segs, 100, 279)
    const raw = DIG.scoreBoxes(boxesFb, mask, W, H, 100, 279, 5)
    const penalized = (segFb.fallback ? raw - 55 : raw)
    const okPenalty = !segFb.fallback || penalized < raw
    const ok = okFlat && okGood && okPenalty
    if (!ok) fails++
    console.log('  ' + (ok ? '✅' : '❌') + ' шум→degenerate=' + (rFlat ? rFlat.degenerate : '?') + ' (жду true) | цифры→' +
      (rGood ? rGood.glyphs.length + '/5, sameFrac=' + rGood.sameFrac + ', degenerate=' + rGood.degenerate : 'сбой') +
      ' (жду 5/5, <0.6, false) | fallback=' + (segFb.fallback) + ' балл ' + raw + '→' + penalized)
    if (!ok) console.log('     ⚠️ okFlat=' + okFlat + ' okGood=' + okGood + ' okPenalty=' + okPenalty)
  }

  console.log('--- v3.12.0: ОФЛАЙН-ТЮНИНГ (--autotune) на синтетических раундах ---')
  {
    // готовим «records»: 6 раундов с настоящими цифрами + ответы человека
    const root = path.join(REC_ROOT || __dirname, 'selftest_autotune')
    try { fs.rmSync(root, { recursive: true, force: true }) } catch (e) {}
    const truth = ['12345', '67890', '24680', '13579', '11223', '98765']
    const stamp = new Date(Date.now() - 3600e3).toISOString().replace(/[:.]/g, '-').replace('T', 'T')
    const answers = []
    for (let i = 0; i < truth.length; i++) {
      const g = makeSyntheticDigits(4, 3, truth[i], 5150 + i * 137)
      const dir = path.join(root, 'round' + String(i + 1).padStart(2, '0') + '_a1_' + stamp)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'ORIGINAL_raw.bin'), Buffer.from(g.img))
      fs.writeFileSync(path.join(dir, 'layout.json'), JSON.stringify({ W: g.W, H: g.H, cols: 4, rows: 3 }, null, 2))
      answers.push({ round: i + 1, answer: truth[i], ts: new Date(Date.now() - 3600e3 + i * 60e3).toISOString(), src: 'selftest', dir: path.basename(dir) })
    }
    const savedAnswers = answersFile()
    try { fs.mkdirSync(LEARN_DIR, { recursive: true }) } catch (e) {}
    fs.writeFileSync(savedAnswers, answers.map(a => JSON.stringify(a)).join('\n') + '\n')
    let at = null, atErr = null
    try { at = await runAutotune(root, {}) } catch (e) { atErr = e }
    const ok = !atErr && at && at.ok && at.images >= 4 && at.acc >= 60
    if (!ok) fails++
    console.log('  ' + (ok ? '✅' : '❌') + ' autotune: ' + (atErr ? 'ошибка ' + atErr.message :
      (at ? 'лучшая маска «' + at.best + '» → ' + at.acc + '% на ' + at.images + ' картинках' : 'нет результата')))
    if (!ok && at) console.log('     ⚠️ ожидали точность ≥60%, топ: ' + (at.rows || []).slice(0, 5).map(r => r.strategy + '=' + r.acc + '%').join(', '))
    // отчёт на диске
    const rep = path.join(LEARN_DIR, 'autotune_report.json')
    const okRep = fs.existsSync(rep)
    if (!okRep) fails++
    console.log('  ' + (okRep ? '✅' : '❌') + ' отчёт autotune_report.json записан')
    try { fs.rmSync(root, { recursive: true, force: true }) } catch (e) {}
    try { fs.rmSync(LEARN_DIR, { recursive: true, force: true }) } catch (e) {}
  }

  // ============ v3.13.0: прокси — парсинг ответа смены IP, SOCKS5, HTTP CONNECT, MC-пинг ============
  console.log('--- v3.13.0: диагностика прокси (parseChangeIpResponse, SOCKS5, HTTP CONNECT, MC status) ---')
  {
    // 1) чистые функции разбора
    const cj = parseChangeIpResponse(200, '{"status":"OK","new_ip":"94.25.229.79","rt":"5.15"}', 'https://changeip.mobileproxy.space/?proxy_key=X&format=json')
    const ch = parseChangeIpResponse(200, '<!DOCTYPE html><html><head><title>Мои прокси</title></head>', 'https://mobileproxy.space/user.html')
    const ci = parseChangeIpResponse(200, '94.25.229.79', 'x')
    const cr = parseChangeIpResponse(200, 'Please wait 30 seconds', 'x')
    const ce = parseChangeIpResponse(200, '', 'x')
    const okParse = cj.kind === 'json' && cj.newIp === '94.25.229.79' && cj.rt === '5.15' &&
      ch.kind === 'html' && ch.title === 'Мои прокси' && /ВЕБ-СТРАНИЦУ/.test(ch.hint) &&
      ci.kind === 'ip' && ci.newIp === '94.25.229.79' &&
      cr.rateLimited === true && ce.kind === 'empty'
    if (!okParse) fails++
    console.log('  ' + (okParse ? '✅' : '❌') + ' parseChangeIpResponse: json/html(«' + ch.title + '»)/ip/rate/empty')

    const okAlt = altHostOf('bproxy.site') === 'mproxy.site' && altHostOf('mproxy.site') === 'bproxy.site' && altHostOf('x.com') === null
    if (!okAlt) fails++
    console.log('  ' + (okAlt ? '✅' : '❌') + ' altHostOf: bproxy↔mproxy, чужой хост → null')

    const okJson = ensureJsonParam('https://x/?k=1') === 'https://x/?k=1&format=json' &&
      ensureJsonParam('https://x/?format=json') === 'https://x/?format=json' &&
      ensureJsonParam('https://x') === 'https://x?format=json'
    if (!okJson) fails++
    console.log('  ' + (okJson ? '✅' : '❌') + ' ensureJsonParam: дописывает format=json, не дублирует')

    const okHint = /proxy-check/.test(socksHint('ConnectionRefused')) && /password|авториз/i.test(socksHint('прокси ОТВЕРГ логин/пароль'))
    if (!okHint) fails++
    console.log('  ' + (okHint ? '✅' : '❌') + ' socksHint: подсказка для ECONNREFUSED и для отказа авторизации')

    // 2) живой SOCKS5 handshake против мок-сервера (с авторизацией, домен-бинд, «лишние» байты одним сегментом)
    const mkSocks = (bindAtyp, creds) => net.createServer(sock => {
      let stage = 0
      sock.on('data', d => {
        if (stage === 0) { const ms = Array.from(d.slice(2, 2 + d[1])); if (ms.includes(0x02)) { sock.write(Buffer.from([0x05, 0x02])); stage = 1 } else { sock.write(Buffer.from([0x05, 0x00])); stage = 2 }; return }
        if (stage === 1) { const ul = d[1], u = d.slice(2, 2 + ul).toString(), pl = d[2 + ul], p = d.slice(3 + ul, 3 + ul + pl).toString(); if (u === creds[0] && p === creds[1]) { sock.write(Buffer.from([0x01, 0x00])); stage = 2 } else { sock.write(Buffer.from([0x01, 0x01])); sock.end() }; return }
        if (stage === 2) {
          stage = 3
          let reply
          if (bindAtyp === 1) reply = Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0x00, 0x50])
          else { const h = Buffer.from('api.ipify.org'); reply = Buffer.concat([Buffer.from([0x05, 0x00, 0x00, 0x03, h.length]), h, Buffer.from([0x00, 0x50])]) }
          sock.write(Buffer.concat([reply, Buffer.from('HTTP/1.1 200 OK\r\n\r\n9.9.9.9')]))
          setTimeout(() => sock.end(), 80)
        }
      })
    })
    const srv1 = mkSocks(3, ['good', 'pass'])
    await new Promise(r => srv1.listen(0, '127.0.0.1', r))
    const p1 = srv1.address().port
    let s1body = null, s1err = null
    try { const s = await socks5Open({ host: '127.0.0.1', port: p1, userId: 'good', password: 'pass' }, 'api.ipify.org', 80, 5000); s1body = await httpThrough(s, 'api.ipify.org', 'GET / HTTP/1.1\r\nHost: api.ipify.org\r\n\r\n', 3000) } catch (e) { s1err = e.message }
    srv1.close()
    const okSocks = !s1err && /9\.9\.9\.9/.test(String(s1body))
    if (!okSocks) fails++
    console.log('  ' + (okSocks ? '✅' : '❌') + ' socks5Open+httpThrough: handshake с auth, домен-бинд, «лишние» байты не потеряны → «' + String(s1body || s1err).slice(0, 30) + '»')

    // 3) SOCKS5 отвергает неверный пароль
    const srv2 = mkSocks(1, ['good', 'pass'])
    await new Promise(r => srv2.listen(0, '127.0.0.1', r))
    const p2 = srv2.address().port
    let s2err = null
    try { await socks5Open({ host: '127.0.0.1', port: p2, userId: 'bad', password: 'x' }, 'api.ipify.org', 80, 5000) } catch (e) { s2err = e.message }
    srv2.close()
    const okReject = /ОТВЕРГ логин/.test(String(s2err))
    if (!okReject) fails++
    console.log('  ' + (okReject ? '✅' : '❌') + ' socks5Open: неверный пароль отвергнут → «' + String(s2err || 'НЕ ОТВЕРГНУТ').slice(0, 50) + '»')

    // 4) ConnectionRefused → понятная ошибка (как в логе 21:19)
    let s3err = null
    try { await socks5Open({ host: '127.0.0.1', port: p2 + 1, userId: 'a', password: 'b' }, 'x', 80, 3000) } catch (e) { s3err = e.message }
    const okRefused = /ОТКАЗАЛ в соединении \(ECONNREFUSED\)/.test(String(s3err))
    if (!okRefused) fails++
    console.log('  ' + (okRefused ? '✅' : '❌') + ' socks5Open: мёртвый порт → «' + String(s3err || 'нет ошибки').slice(0, 70) + '»')

    // 5) HTTP CONNECT (mproxy.site) + авторизация Basic
    const srvH = net.createServer(sock => {
      let head = ''
      sock.on('data', d => {
        head += d.toString('latin1')
        if (head.indexOf('\r\n\r\n') < 0) return
        if (!/^CONNECT /.test(head)) { sock.end('HTTP/1.1 400 Bad\r\n\r\n'); return }
        const okAuth = /Proxy-Authorization: Basic /.test(head)
        if (!okAuth) { sock.end('HTTP/1.1 407 Proxy Auth Required\r\n\r\n'); return }
        sock.write('HTTP/1.1 200 Connection established\r\n\r\n')
        sock.write('HTTP/1.1 200 OK\r\n\r\n7.7.7.7'); setTimeout(() => sock.end(), 80)
      })
    })
    await new Promise(r => srvH.listen(0, '127.0.0.1', r))
    const pH = srvH.address().port
    let hbody = null, herr = null
    try { const s = await httpConnect({ host: '127.0.0.1', port: pH, userId: 'u', password: 'p' }, 'api.ipify.org', 80, 5000); hbody = await httpThrough(s, 'api.ipify.org', 'GET / HTTP/1.1\r\nHost: api.ipify.org\r\n\r\n', 3000) } catch (e) { herr = e.message }
    srvH.close()
    const okHttp = !herr && /7\.7\.7\.7/.test(String(hbody))
    if (!okHttp) fails++
    console.log('  ' + (okHttp ? '✅' : '❌') + ' httpConnect: HTTP-прокси + Basic-auth → «' + String(hbody || herr).slice(0, 30) + '»')

    // 6) mcStatusPing: мок MC-сервера отдаёт status JSON
    const varint = n => { const b = []; do { let x = n & 0x7f; n >>>= 7; if (n) x |= 0x80; b.push(x) } while (n); return Buffer.from(b) }
    const srvM = net.createServer(sock => {
      sock.on('data', () => {
        const json = JSON.stringify({ version: { name: '1.21.1', protocol: 767 }, players: { max: 100, online: 42 }, description: { text: 'FunTime' } })
        const body = Buffer.concat([varint(0x00), Buffer.from(json, 'utf8')])
        sock.write(Buffer.concat([varint(body.length), body])); setTimeout(() => sock.end(), 60)
      })
    })
    await new Promise(r => srvM.listen(0, '127.0.0.1', r))
    const pM = srvM.address().port
    const msock = net.connect({ host: '127.0.0.1', port: pM })
    await new Promise(r => msock.once('connect', r))
    const mp = await mcStatusPing(msock, 5000)
    srvM.close()
    const okMc = mp.ok && mp.json && mp.json.version && mp.json.version.protocol === 767 && mp.json.players.online === 42
    if (!okMc) fails++
    console.log('  ' + (okMc ? '✅' : '❌') + ' mcStatusPing: разобрал status-ответ сервера (protocol ' + (mp.json && mp.json.version ? mp.json.version.protocol : '?') + ', online ' + (mp.json && mp.json.players ? mp.json.players.online : '?') + ')')
  }

  LEARN_DIR = learnWas
  if (!CLI.debug) {
    for (const d of ['selftest_e2e', 'selftest_e2e_light', 'selftest_learn', 'selftest']) {
      try { fs.rmSync(path.join(REC_ROOT || __dirname, d), { recursive: true, force: true }) } catch (e) {}
    }
  } else console.log('  (--debug: артефакты самопроверки оставлены в ' + path.join(REC_ROOT || __dirname, 'selftest_learn') + ')')
  console.log(fails ? '=== SELFTEST: ' + fails + ' ПРОВАЛОВ ===' : '=== SELFTEST: ВСЁ ОК ===')
  return fails === 0
}

// ========================= REPLAY: пересобрать из записи =========================
function replayDir(dir) {
  step('REPLAY: ' + dir)
  const framesPath = path.join(dir, 'frames.json')
  if (!fs.existsSync(framesPath)) { step('нет frames.json в ' + dir); return null }
  const frames = JSON.parse(fs.readFileSync(framesPath, 'utf8'))
  const maps = new Map()
  const tilesDirs = ['tiles', '.'].map(x => path.join(dir, x))
  for (const td of tilesDirs) {
    if (!fs.existsSync(td)) continue
    for (const f of fs.readdirSync(td)) {
      const m = f.match(/map(\d+)(?:_rot\d+)?\.bin$/)
      if (!m) continue
      const id = Number(m[1])
      if (maps.has(id)) continue
      const buf = fs.readFileSync(path.join(td, f))
      maps.set(id, new Uint8Array(buf.buffer, buf.byteOffset, buf.length))
    }
  }
  step('загружено tiles=' + maps.size + ' frames=' + frames.length)
  let view = null
  try { view = JSON.parse(fs.readFileSync(path.join(dir, 'view.json'), 'utf8')) } catch (e) {}
  const snap = { maps, frames, chats: [], events: ['replay'], view }
  const out = path.join(dir, 'rebuild_' + STAMP)
  return { snap, out }
}

// ========================= TELEGRAM: ТРАНСПОРТ =========================
function tgLogFile() { return path.join(LEARN_DIR, 'telegram.log') }
function tgLog(msg) {
  const line = logStamp() + ' [TG] ' + msg
  try { fs.mkdirSync(LEARN_DIR, { recursive: true }); fs.appendFileSync(tgLogFile(), line + '\n') } catch (e) {}
  step('[TG] ' + msg)
}

// принимает: socks5://u:p@host:port, socks5h://u:p@host:port, socks4://...,
//            u:p@host:port и host:port (без схемы и без логина)
function parseSocksUrl(s) {
  try {
    let str = String(s || '').trim()
    if (!str) return null
    let type = 5
    const pm = str.match(/^(socks[45])h?:\/\//i)
    if (pm) { type = pm[1].toLowerCase() === 'socks4' ? 4 : 5; str = str.slice(pm[0].length) }
    else if (/^[a-z0-9]+:\/\//i.test(str)) return null
    const at = str.lastIndexOf('@')
    let user = '', pass = ''
    if (at >= 0) {
      const auth = str.slice(0, at)
      str = str.slice(at + 1)
      const ci = auth.indexOf(':')
      if (ci >= 0) { user = auth.slice(0, ci); pass = auth.slice(ci + 1) } else user = auth
    }
    const hm = str.match(/^\[?([^\]:]+)\]?:(\d+)\/?$/)
    if (!hm) return null
    return {
      type, host: hm[1], port: Number(hm[2]),
      username: decodeURIComponent(user), password: decodeURIComponent(pass)
    }
  } catch (e) { return null }
}

// открывает туннель до (host:port) через SOCKS и возвращает «голый» сокет.
// type 4 → модуль socks (если есть); type 5 → встроенный клиент (работает без npm-пакета socks).
async function openSocksTunnel(host, port, socks, timeoutMs) {
  const type = Number(socks.type) || 5
  if (type !== 5 && SocksClient) {
    const conn = await SocksClient.createConnection({
      proxy: { host: socks.host, port: socks.port, type, userId: socks.username, password: socks.password },
      command: 'connect', destination: { host, port }
    })
    return conn.socket
  }
  if (SocksClient && type === 5) {
    try {
      const conn = await SocksClient.createConnection({
        proxy: { host: socks.host, port: socks.port, type: 5, userId: socks.username, password: socks.password },
        command: 'connect', destination: { host, port }
      })
      return conn.socket
    } catch (e) { /* пробуем встроенный клиент (резервный хост и т.п.) */ }
  }
  return await socks5Open({ host: socks.host, port: socks.port, userId: socks.username, password: socks.password }, host, port, timeoutMs || 25000)
}

function socksTlsConnect(host, port, socks, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false, raw = null
    const to = setTimeout(() => { if (!done) { done = true; try { if (raw) raw.destroy() } catch (e) {}; reject(new Error('SOCKS timeout')) } }, timeoutMs || 25000)
    openSocksTunnel(host, port, socks, timeoutMs || 25000).then(sock => {
      raw = sock
      if (done) { try { sock.destroy() } catch (e) {} return }
      let secure = null
      try {
        secure = tls.connect({ socket: sock, servername: host, minVersion: 'TLSv1.2' }, () => {
          if (done) return
          done = true; clearTimeout(to)
          resolve({ socket: secure, cleanup() { try { secure.destroy() } catch (e) {} try { sock.destroy() } catch (e) {} } })
        })
      } catch (e) { if (!done) { done = true; clearTimeout(to); try { sock.destroy() } catch (x) {}; reject(e) }; return }
      secure.on('error', e => { if (!done) { done = true; clearTimeout(to); try { sock.destroy() } catch (x) {}; reject(e) } })
    }).catch(e => { if (!done) { done = true; clearTimeout(to); reject(e) } })
  })
}

async function httpsRequest(o) {
  const secure = o.secure !== false
  const host = o.host, port = o.port || (secure ? 443 : 80)
  const mod = secure ? https : http
  let sock = null
  if (o.socks) {
    if (!secure) { /* через SOCKS без TLS не ходим */ }
    else {
      try { sock = await socksTlsConnect(host, port, o.socks, Math.min(25000, o.timeoutMs || 30000)) }
      catch (e) { return { ok: false, error: 'SOCKS: ' + ((e && e.message) || e) } }
    }
  }
  return await new Promise(resolve => {
    const headers = Object.assign({}, o.headers || {})
    if (o.body) headers['Content-Length'] = Buffer.isBuffer(o.body) ? o.body.length : Buffer.byteLength(o.body)
    const opts = { hostname: host, port, path: o.path, method: o.method || 'POST', timeout: o.timeoutMs || 30000, headers }
    if (sock) opts.createConnection = () => sock.socket
    let req
    try {
      req = mod.request(opts, res => {
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => { if (sock) try { sock.cleanup() } catch (e) {}; resolve({ ok: true, status: res.statusCode, body: Buffer.concat(chunks) }) })
        res.on('error', e => { if (sock) try { sock.cleanup() } catch (x) {}; resolve({ ok: false, error: 'RES: ' + e.message }) })
      })
    } catch (e) { if (sock) try { sock.cleanup() } catch (x) {}; resolve({ ok: false, error: 'REQ: ' + ((e && e.message) || e) }); return }
    req.on('error', e => { if (sock) try { sock.cleanup() } catch (x) {}; resolve({ ok: false, error: ((e && e.code) ? e.code + ' ' : '') + e.message }) })
    req.on('timeout', () => { try { req.destroy() } catch (e) {}; if (sock) try { sock.cleanup() } catch (x) {}; resolve({ ok: false, error: 'timeout' }) })
    if (o.body) req.write(o.body)
    req.end()
  })
}

function tgMultipart(fields, file) {
  const b = '----tg' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
  const parts = []
  for (const k of Object.keys(fields)) {
    if (fields[k] === undefined || fields[k] === null) continue
    parts.push(Buffer.from('--' + b + '\r\nContent-Disposition: form-data; name="' + k + '"\r\n\r\n' + String(fields[k]) + '\r\n'))
  }
  if (file) {
    parts.push(Buffer.from('--' + b + '\r\nContent-Disposition: form-data; name="' + file.field + '"; filename="' + file.name + '"\r\nContent-Type: ' + (file.type || 'application/octet-stream') + '\r\n\r\n'))
    parts.push(Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data))
    parts.push(Buffer.from('\r\n'))
  }
  parts.push(Buffer.from('--' + b + '--\r\n'))
  return { body: Buffer.concat(parts), contentType: 'multipart/form-data; boundary=' + b }
}

let tgTransport = null
function tgTransports() {
  let isHttp = false
  try { isHttp = new URL(TG.apiUrl).protocol === 'http:' } catch (e) {}
  if (isHttp) return ['direct']        // локальный/тестовый endpoint — прокси не нужен

  const direct = 'direct'
  const s = parseSocksUrl(TG.socksUrl)
  const tgProxy = s ? { name: 'tg-proxy(' + s.host + ':' + s.port + ')', socks: s } : null
  const mc = (TG.useMcProxy && PROXY.host)
    ? { name: 'mc-proxy(' + PROXY.host + ')', socks: { type: 5, host: PROXY.host, port: PROXY.port, username: PROXY.username, password: PROXY.password } }
    : null
  // специальный прокси первым (если задан): прямой доступ к Telegram обычно заблокирован
  const list = []
  if (tgProxy && TG.preferSocks) list.push(tgProxy)
  list.push(direct)
  if (tgProxy && !TG.preferSocks) list.push(tgProxy)
  if (mc) list.push(mc)
  return list
}
function tgTransportByName(n) {
  if (n === 'direct' || !n) return 'direct'
  const f = tgTransports().find(t => t !== 'direct' && t.name === n)
  return f || 'direct'
}

// вызов метода Telegram Bot API: сначала рабочий транспорт, потом остальные
async function tgApi(method, params, file, timeoutMs, onlyTransport) {
  if (!TG.token) return { ok: false, description: 'нет telegram.token' }
  let u
  try { u = new URL(TG.apiUrl + '/bot' + TG.token + '/' + method) } catch (e) { return { ok: false, description: 'плохой telegram.apiUrl' } }
  const order = []
  if (onlyTransport) order.push(onlyTransport)
  else {
    if (tgTransport) order.push(tgTransport)
    for (const t of tgTransports()) if (order.indexOf(t) < 0) order.push(t)
  }

  const errs = []
  let lastErr = 'нет транспорта'
  for (const tr of order) {
    for (let retry = 0; retry < 2; retry++) {
      let body = null, headers = {}
      if (file) { const mp = tgMultipart(params || {}, file); body = mp.body; headers['Content-Type'] = mp.contentType }
      else { body = JSON.stringify(params || {}); headers['Content-Type'] = 'application/json' }
      const socks = (tr === 'direct') ? null : tr.socks
      const tName = (tr === 'direct') ? 'direct' : tr.name
      const secure = u.protocol !== 'http:'
      const r = await httpsRequest({ host: u.hostname, port: Number(u.port || (secure ? 443 : 80)), path: u.pathname + u.search, method: 'POST', headers, body, timeoutMs: timeoutMs || TG.timeoutMs, socks, secure })
      if (!r.ok) {
        lastErr = tName + ': ' + r.error
        if (errs.indexOf(lastErr) < 0) errs.push(lastErr)
        if (/модуль socks не установлен/.test(r.error)) tgLog('⚠️ нужен пакет socks: npm i socks (без него прокси-транспорты не работают)')
        else tgLog('API ' + method + ' через ' + tName + ' не прошёл: ' + r.error)
        break
      }
      let json = null
      try { json = JSON.parse(r.body.toString('utf8')) } catch (e) {}
      if (r.status === 429) {
        const ra = json && json.parameters && json.parameters.retry_after ? Number(json.parameters.retry_after) : 3
        tgLog('429 too many requests, жду ' + ra + 'с')
        await sleep(Math.min(30, ra) * 1000)
        continue
      }
      if (json && json.ok) {
        if (tgTransport !== tr) { tgTransport = tr; tgLog('транспорт: ' + tName) }
        return json
      }
      const d = (json && json.description) || ('HTTP ' + r.status + ' ' + r.body.toString('utf8').slice(0, 200))
      return { ok: false, error_code: r.status, description: tName + ': ' + d }
    }
  }
  return { ok: false, description: errs.length ? errs.join(' | ') : lastErr }
}

async function tgSendText(text) {
  const r = await tgApi('sendMessage', { chat_id: TG.chatId, text, disable_web_page_preview: true })
  if (!r.ok) tgLog('sendMessage ошибка: ' + (r.description || r.error_code))
  return r
}
async function tgSendPhoto(png, caption) {
  const r = await tgApi('sendPhoto', { chat_id: TG.chatId, caption, parse_mode: '' }, { field: 'photo', name: 'captcha.png', type: 'image/png', data: png })
  if (!r.ok) tgLog('sendPhoto ошибка: ' + (r.description || r.error_code))
  return r
}

// ========================= TELEGRAM: ОЧЕРЕДЬ И РАЗМЕТКА =========================
class AsyncQueue {
  constructor(cap) { this.cap = Math.max(1, cap); this.items = []; this.closed = false; this.pushWait = []; this.shiftWait = [] }
  async push(x) {
    while (this.items.length >= this.cap && !this.closed) await new Promise(r => this.pushWait.push(r))
    if (this.closed) return false
    this.items.push(x)
    const w = this.shiftWait.shift()
    if (w) w()
    return true
  }
  async shift() {
    while (!this.items.length && !this.closed) await new Promise(r => this.shiftWait.push(r))
    if (!this.items.length) return null
    const x = this.items.shift()
    // обязательно будим того, кто ждёт места в очереди, иначе deadlock
    const w = this.pushWait.shift()
    if (w) w()
    return x
  }
  close() { this.closed = true; while (this.pushWait.length) this.pushWait.shift()(); while (this.shiftWait.length) this.shiftWait.shift()() }
  get size() { return this.items.length }
}

// разметка глифов ответом пользователя: цифры сопоставляются слева направо
function labelRoundWithDigits(store, rec, round, digits) {
  const items = (rec.digitItems || []).filter(it => it.feat)
  if (!items.length) return { ok: false, reason: 'нет глифов' }
  if (digits.length !== items.length) return { ok: false, reason: 'не совпало количество', found: items.length, got: digits.length }
  let added = 0
  items.forEach((it, i) => {
    try {
      const ids = store.addAugmented(Number(digits[i]), it.feat, { src: 'tg:round' + round + ':' + i, aspect: it.w / Math.max(1, it.h) })
      added += ids.length
    } catch (e) { tgLog('store.add err: ' + e.message) }
  })
  return { ok: true, n: items.length, variants: added }
}

// убрать глифы этого раунда из очереди ручной разметки (они уже размечены через TG)
function dropQueueRound(round) {
  try {
    const q = new DIG.LabelQueue(LEARN_DIR)
    const before = q.items.length
    q.items = q.items.filter(it => Number(it.round) !== Number(round))
    if (q.items.length !== before) q.save()
    return before - q.items.length
  } catch (e) { return 0 }
}

// полоса из нормализованных глифов (для команды /glyphs и диагностики)
function glyphStripPng(items) {
  const list = (items || []).filter(it => it.feat)
  if (!list.length) return null
  const stride = DIG.GW + 8
  const W = list.length * stride + 6, H = DIG.GH + 8
  const canvas = new Uint8Array(W * H)
  canvas.fill(255)
  list.forEach((it, i) => {
    const ox = 4 + i * stride
    for (let y = 0; y < DIG.GH; y++) for (let x = 0; x < DIG.GW; x++) {
      const v = Number(it.feat[y * DIG.GW + x]) || 0
      canvas[(y + 4) * W + ox + x] = Math.max(0, Math.min(255, Math.round(255 * (1 - v))))
    }
    if (i > 0) for (let y = 2; y < H - 2; y++) canvas[y * W + ox - 4] = 190
  })
  return DIG.pngGray(W, H, 4, (x, y) => canvas[y * W + x])
}

// обучение MLP из накопленной базы (используется и в --train, и в автообучении)
function trainModel(store, opts) {
  opts = opts || {}
  if (store.size < 20) return { ok: false, reason: 'мало данных (' + store.size + ')' }
  const idx = [...Array(store.size).keys()]
  for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = idx[i]; idx[i] = idx[j]; idx[j] = t }
  const nTest = Math.max(1, Math.floor(idx.length * 0.2))
  const testIdx = idx.slice(0, nTest), trainIdx = idx.slice(nTest)
  const X = a => a.map(i => Array.from(store.samples[i].feat))
  const Y = a => a.map(i => store.samples[i].digit)
  const t0 = Date.now()
  const mlp = new DIG.MLP(DIG.FEAT_DIM, Number(cfgGet(CFG, 'digits.hidden', 20)) || 20, 10)
  const hist = mlp.train(X(trainIdx), Y(trainIdx), { epochs: Number(cfgGet(CFG, 'digits.epochs', 150)) || 150, batch: 8, lr: 0.03 })
  const res = {
    ok: true, ms: Date.now() - t0, samples: store.size,
    loss0: hist.length ? hist[0].loss : null, loss1: hist.length ? hist[hist.length - 1].loss : null,
    accTrain: mlp.accuracy(X(trainIdx), Y(trainIdx)), accTest: mlp.accuracy(X(testIdx), Y(testIdx)), testSize: nTest,
    counts: store.counts(), mlp
  }
  mlp.save(LEARN_DIR)
  return res
}

// Картинки готовятся ЗАРАНЕЕ (конвейер), поэтому к моменту отправки база уже
// могла вырасти. Признаки глифов не меняются — меняем только классификатор:
// пересчитываем предсказание по текущей базе и модели.
function refreshPrediction(rec, store, model) {
  try {
    const items = (rec.digitItems || []).filter(it => it.feat).map(it => {
      const knn = store ? store.classify(it.feat) : null
      let mlp = null
      if (model) { try { mlp = model.predict(it.feat) } catch (e) {} }
      let pick = null
      if (knn && mlp) pick = (mlp.conf >= (knn.trust || 0)) ? mlp : knn
      else pick = knn || mlp
      const conf = pick ? Math.round(((pick.trust != null ? pick.trust : pick.conf) || 0) * 1000) / 1000 : 0
      return {
        x: it.x, y: it.y, w: it.w, h: it.h, bbox: it.bbox, feat: it.feat,
        digit: pick ? pick.digit : null, conf, method: pick ? pick.method : 'none',
        guess: pick ? pick.digit : null, knn: knn, mlp: mlp ? { digit: mlp.digit, conf: Math.round(mlp.conf * 1000) / 1000 } : null
      }
    })
    const prediction = items.map(it => (it.digit === null || it.digit === undefined) ? '?' : String(it.digit)).join('')
    const avgConf = items.length ? Math.round(items.reduce((s, it) => s + (it.conf || 0), 0) / items.length * 100) / 100 : 0
    return {
      items, prediction, avgConf,
      text: items.filter(it => it.conf >= DIG_CONF_OK).map(it => String(it.digit)).join(''),
      complete: DIGITS_EXPECTED > 0
        ? (items.length === DIGITS_EXPECTED && prediction.length === DIGITS_EXPECTED && prediction.indexOf('?') < 0)
        : items.length > 0
    }
  } catch (e) { return null }
}

// ========================= TELEGRAM: СЕССИЯ ОБУЧЕНИЯ =========================
// Правила (как договорились):
//  • в капче ВСЕГДА ровно DIGITS_EXPECTED (5) цифр;
//  • вместе с фото бот ВСЕГДА присылает своё предсказание;
//  • ответ человека = истина: эти цифры уходят в обучающую базу;
//  • сессия идёт, пока предсказание бота не совпадёт с ответом 10 раз ПОДРЯД.
async function runTelegramSession(ctx, captureFn) {
  const doCapture = captureFn || captureRound
  const store = new DIG.GlyphStore(LEARN_DIR)
  let model = DIG.MLP.load(LEARN_DIR)
  const q = new AsyncQueue(TG.prefetch)
  const st = {
    offset: 0, pending: [], startedAt: 0, stop: false, rounds: 0, labeled: 0, newLabels: 0, skipped: 0, yoloHits: 0,
    streak: 0, bestStreak: 0, matches: 0, mismatches: 0, incomplete: 0, degenerate: 0,
    lastModelInfo: null, doneByStreak: false, me: null
  }

  const me = await tgApi('getMe', null, null, TG.probeTimeoutMs)
  if (!me.ok) {
    tgLog('❌ getMe не прошёл: ' + (me.description || me.error_code) + ' — работаю БЕЗ Telegram')
    tgLog('   диагностика: node main.js --tg-test')
    return { ok: false, st }
  }
  st.me = me.result
  if (FAST_CFG !== false && !FAST_MODE) {
    FAST_MODE = true
    tgLog('⚡ быстрый режим ВКЛ: пауза между раундами ' + FAST.pauseBetween + 'мс (вместо ' + PAUSE_BETWEEN_MS +
      '), ожидание тишины ' + FAST.stableMs + 'мс (вместо ' + CAP.stableMs + '), добор ' + FAST.settleMs + 'мс (вместо ' + SETTLE_MS +
      '), облегчённые файлы=' + FAST.lightFiles)
  } else if (FAST_MODE) {
    tgLog('⚡ быстрый режим ВКЛ (через config capture.fast=true)')
  } else {
    tgLog('быстрый режим ВЫКЛ (capture.fast=false) — паузы как в обычном прогоне')
  }
  tgLog('бот @' + (me.result && me.result.username) + ' (id ' + (me.result && me.result.id) + ') | chat_id=' + TG.chatId +
    ' | транспорт=' + (tgTransport === 'direct' ? 'direct' : (tgTransport && tgTransport.name)))
  tgLog('база цифр: ' + store.size + ' ' + JSON.stringify(store.counts()) + (model ? ' | MLP загружена' : ' | MLP нет'))
  if (!model && DIG.MLP._stale) {
    tgLog('⚠️ найдена model.json от старой версии признаков (fv=' + DIG.MLP._staleFv + ', сейчас fv=' + DIG.FEAT_VERSION +
      ') — НЕ загружена, иначе давала бы уверенный бред. Обучите заново: /train или node main.js --train')
  }
  tgLog('YOLO API: ' + (YOLO.enabled ? 'ВКЛ, порядок: ' + YOLO.urls.join(' → ') : 'ВЫКЛ') +
    ' | счётчик «подряд» считает: ' + TG.streakSource)
  tgLog('цифр в капче: ' + DIGITS_EXPECTED + ' | цель: ' + TG.targetStreak + ' совпадений подряд | лимит раундов: ' + TG.maxRounds)

  // Сброс старых апдейтов: Telegram хранит неподтверждённые сообщения, и без этого
  // новая сессия получала вчерашний /stop и сразу завершалась (реальный баг из лога:
  // «ответ «/stop» (update_id=785300572)» — тот же id, что в прошлой сессии).
  st.startedAt = Math.floor(Date.now() / 1000)
  const flush = await tgApi('getUpdates', { offset: -1, timeout: 0 })
  if (flush && flush.ok && Array.isArray(flush.result) && flush.result.length) {
    const lastId = flush.result[flush.result.length - 1].update_id
    st.offset = lastId + 1
    tgLog('сброшено старых апдейтов: ' + flush.result.length + ', offset установлен в ' + st.offset)
  } else {
    tgLog('старых апдейтов нет')
  }

  await tgSendText('🟢 Бот запущен (v3.12.0)\n' +
    'В капче всегда ' + DIGITS_EXPECTED + ' цифр. Цель обучения: ' + TG.targetStreak + ' совпадений подряд.\n' +
    'База цифр: ' + store.size + ' примеров' + (store.size ? '' : ' (пуста — первые ответы её создадут)') + '\n\n' +
    'Я присылаю картинку и СВОЁ ПРЕДСКАЗАНИЕ. Вы отвечаете правильными цифрами:\n' +
    '• ' + '4'.repeat(DIGITS_EXPECTED) + ' — свои цифры (они и есть истина, идут в обучение)\n' +
    '• «+» — моё предсказание верное\n' +
    '• /skip — пропустить · /glyphs — что я вырезал · /diag — диагностика нарезки\n' +
    '• /status · /train · /yolo · /stop')

  // ---------- производитель: снимает раунды вперёд ----------
  const producer = (async () => {
    try {
      for (let r = 1; r <= TG.maxRounds && !st.stop && !ctx.aborted; r++) {
        const t0 = Date.now()
        let rec = null
        try { rec = await doCapture(r, ctx) }
        catch (e) { tgLog('❌ раунд ' + r + ': исключение при сборе: ' + ((e && e.message) || e)) }
        st.rounds++
        await q.push({ round: r, rec, ms: Date.now() - t0 })
        if (!st.stop) {
          const tm = ctx.lastTimings || {}
          tgLog('раунд ' + r + ' подготовлен за ' + ((Date.now() - t0) / 1000).toFixed(1) + 'с' +
            ' (сеть ' + ((tm.net || 0) / 1000).toFixed(1) + 'с + сборка ' + ((tm.save || 0) / 1000).toFixed(1) + 'с)' +
            ' | в очереди заранее: ' + q.size + '/' + TG.prefetch)
        }
      }
    } catch (e) {
      tgLog('❌ производитель упал: ' + ((e && e.message) || e))
    } finally {
      q.close()
      tgLog('сбор остановлен: раундов ' + st.rounds)
    }
  })()

  // ---------- потребитель: шлёт картинку + предсказание, ждёт ответ, учится ----------
  const consumer = (async () => {
    try {
      while (!st.stop) {
        const item = await q.shift()
        if (!item) break
        const { round, rec } = item
        let botAnswer = '', botSrc = 'нет'

        if (!rec) {
          // причина провала обязательна в telegram.log: иначе видно только
          // «подготовлен за 52с (сеть 0.0с + сборка 0.0с)» и непонятно, что случилось
          const why = (ctx.lastNote || ctx.lastFail || 'нет данных')
          tgLog('раунд ' + round + ': ❌ картинка не собралась — ' + why +
            ' (попыток ' + (ctx.lastAttempts || '?') + ', IP ' + (currentRunIp || '?') +
            (ctx.proxyDead ? ', ПРОКСИ МЁРТВ' : '') + (ctx.aborted ? ', сбор прерван' : '') + ')')
          await tgSendText('⚠️ Раунд ' + round + ': картинка не собралась.\nПричина: ' + why +
            '\nПрокси: ' + (PROXY.host || '—') + (ctx.proxyDead ? ' (МЁРТВ — смените IP/прокси)' : '') +
            '\nПолный лог: records/report_*.txt. Еду дальше.')
          continue
        }

        // пересчитываем предсказание ТЕКУЩЕЙ базой (картинка готовилась заранее)
        const fresh = refreshPrediction(rec, store, model)
        const items = fresh ? fresh.items : (rec.digitItems || []).filter(it => it.feat)
        const pred = fresh ? fresh.prediction : (rec.prediction || '')
        const avgConf = fresh ? fresh.avgConf : (rec.avgConf || 0)
        const complete = !!(fresh ? fresh.complete : (items.length === DIGITS_EXPECTED && pred.length === DIGITS_EXPECTED && pred.indexOf('?') < 0))
        if (pred !== (rec.prediction || '')) tgLog('раунд ' + round + ': предсказание обновлено базой "' + (rec.prediction || '') + '" → "' + pred + '"')
        let png = null
        try { png = fs.readFileSync(rec.pngFile) } catch (e) { try { png = fs.readFileSync(rec.pngFile2x) } catch (e2) {} }
        if (!png) { await tgSendText('⚠️ Раунд ' + round + ': не удалось прочитать картинку с диска'); continue }

        // ответ бота = YOLO (85-91%), если он ответил; иначе локальная модель
        const yoloDigits = rec.yolo && rec.yolo.digits ? String(rec.yolo.digits) : ''
        const yoloOk = yoloDigits.length === DIGITS_EXPECTED
        const srcMode = TG.streakSource
        if (srcMode === 'yolo') botAnswer = yoloOk ? yoloDigits : ''
        else if (srcMode === 'local') botAnswer = complete ? pred : ''
        else botAnswer = yoloOk ? yoloDigits : (complete ? pred : '')
        botSrc = (yoloOk && botAnswer === yoloDigits) ? 'YOLO' : (botAnswer ? 'локально' : 'нет')
        const disagree = yoloOk && complete && yoloDigits !== pred

        const segLine = rec.segStrategy
          ? ('🧩 Маска: ' + rec.segStrategy + ' (балл ' + rec.segScore +
             (rec.segFallback ? ', нарезка равномерная ⚠️' : '') + ')')
          : '🧩 Сегментация: запасной метод'
        // если кропы одинаковые — маска режет НЕ цифры; учиться на таком нельзя
        const degLine = rec.segDegenerate
          ? ('🧨 КРОПЫ ОДИНАКОВЫЕ (' + Math.round((rec.segSameFrac || 0) * 100) + '% пар) — я режу не цифры.\n' +
             '   В базу это не пойдёт. Пришлите /diag, затем на ПК:\n' +
             '   node main.js --import-answers learn\\telegram.log\n' +
             '   node main.js --autotune --apply\n')
          : ''
        const cap = '🖼 Раунд ' + round + ' · стена ' + rec.wall + ' ' + rec.cols + '×' + rec.rows + ' · seam ' + rec.seamCost + '\n' +
          '🌐 YOLO API: ' + (yoloDigits ? yoloDigits + (yoloOk ? '' : ' ⚠️не 5 цифр') + '  (' + rec.yolo.host + ', ' + rec.yolo.ms + 'мс)' : 'нет ответа') + '\n' +
          '🤖 Локально: ' + (pred || '—') + '  (уверенность ' + avgConf + ', база ' + store.size + ')\n' +
          (disagree ? '⚠️ YOLO и локальная модель расходятся — сверьте глазами\n' : '') +
          '🔤 Найдено цифр: ' + items.length + ' из ' + DIGITS_EXPECTED +
          (items.length === DIGITS_EXPECTED ? '' : '  ⚠️ НЕ ВСЕ — пришлите /skip') + '\n' +
          segLine + '\n' +
          degLine +
          '🎯 Совпадений подряд: ' + st.streak + '/' + TG.targetStreak + ' (считаем ответ: ' + botSrc + ')\n\n' +
          (items.length === DIGITS_EXPECTED
            ? 'Ответьте «+», если «' + (botAnswer || '?') + '» верно, либо пришлите свои ' + DIGITS_EXPECTED + ' цифр'
            : 'Цифры нашлись не все — ответьте /skip (я запишу проблему в лог) или /glyphs')
        const sent = await tgSendPhoto(png, cap)
        if (!sent.ok) { tgLog('не отправил фото раунда ' + round + ': ' + (sent.description || '')); continue }
        tgLog('раунд ' + round + ': фото отправлено (message_id=' + (sent.result && sent.result.message_id) + ')' +
          ' цифр=' + items.length + '/' + DIGITS_EXPECTED +
          ' | YOLO="' + (yoloDigits || 'нет ответа') + '"' +
          ' | локально="' + pred + '" (уверенность ' + avgConf + ')' +
          ' | ответ бота=' + (botAnswer || '—') + ' (' + botSrc + ')' +
          ' | streak=' + st.streak + ' база=' + store.size)
        if (TG.sendGlyphStrip && items.length) {
          const strip = glyphStripPng(items)
          if (strip) await tgSendPhoto(strip, 'Что я вырезал (раунд ' + round + ', слева направо)')
        }

        // ---------- ждём ответ ----------
        let answered = false
        while (!answered && !st.stop) {
          const msg = await tgWaitMessage(st)
          if (!msg) continue
          const text = String((msg.text || '')).trim()
          const low = text.toLowerCase()
          const botName = ((st.me && st.me.username) || '').toLowerCase()
          tgLog('раунд ' + round + ': ответ «' + text.slice(0, 60) + '» (update_id=' + msg.update_id + ')')

          // Команда может прийти С АРГУМЕНТОМ: «/glyphs 82502», «/skip не вижу цифр».
          // Раньше такое сообщение не находило обработчик и молча проваливалось в
          // «пришлите ровно 5 цифр» (реальный лог 13:12:22 — «/glyphs 82502» без ответа).
          const cmdM = low.match(/^\/([a-z]+)(@[a-z0-9_]+)?([\s\S]*)$/)
          const cmd = cmdM ? '/' + cmdM[1] : ''
          const cmdOk = !!cmdM && (!cmdM[2] || cmdM[2] === '@' + botName)
          const cmdArg = cmdM ? String(cmdM[3] || '').trim() : ''
          // текст, из которого достаём цифры: обычно само сообщение, но для
          // «/glyphs 82502» — аргумент команды (человек хотел и посмотреть, и ответить)
          let argText = text

          if (cmdOk && cmd === '/stop') {
            st.stop = true; ctx.aborted = true
            await finishSession(st, store, '⏹ Остановлено по команде')
            break
          }
          if (cmdOk && cmd === '/help') {
            await tgSendText('Пришлите ' + DIGITS_EXPECTED + ' цифр — это истина, она идёт в обучение.\n' +
              '«+» — моё предсказание верное\n/skip — пропустить картинку\n/glyphs — показать вырезанные глифы\n' +
              '/diag — диагностика нарезки (какая маска, что в кропах, топ стратегий)\n' +
              '/status — база, точность, счётчик совпадений\n/yolo — проверить YOLO API на этой картинке\n' +
              '/train — обучить MLP сейчас\n/stop — остановить')
            continue
          }
          if (cmdOk && cmd === '/status') {
            await tgSendText('📊 Совпадений подряд: ' + st.streak + '/' + TG.targetStreak + ' (рекорд ' + st.bestStreak + ')\n' +
              'YOLO API: ' + (YOLO.enabled ? ((yoloAlive || 'не отвечал') + ' | угадал ' + (st.yoloHits || 0) + ' раз') : 'выключен') + '\n' +
              'Совпало: ' + st.matches + ' | не совпало: ' + st.mismatches + ' | неполных картинок: ' + st.incomplete + '\n' +
              'Раундов: ' + st.rounds + ' | размечено глифов: ' + st.labeled + ' | пропущено: ' + st.skipped +
                (st.degenerate ? ' | 🧨 выродившаяся нарезка: ' + st.degenerate : '') + '\n' +
              'База: ' + store.size + ' ' + JSON.stringify(store.counts()) + '\n' +
              'MLP: ' + (model ? 'есть' : 'нет') + (st.lastModelInfo ? ' — ' + st.lastModelInfo : '') + '\n' +
              'Очередь ручной разметки: ' + (new DIG.LabelQueue(LEARN_DIR)).size)
            continue
          }
          if (cmdOk && cmd === '/glyphs') {
            const strip = glyphStripPng(items)
            if (strip) await tgSendPhoto(strip, 'Глифы раунда ' + round + ' (слева направо). Предсказание: ' +
              items.map((it, i) => (i + 1) + ') ' + (it.guess === null || it.guess === undefined ? '?' : it.guess) + '·' + it.conf).join('  '))
            else await tgSendText('Глифов нет — вырезать нечего. Похоже, нужно поправить пороги (digits.minGlyphH / maxGlyphH)')
            // ASCII-превью кропов текстом: его можно скопировать и показать человеку,
            // даже если картинка в чате выглядит непонятно
            try {
              const norms = items.map(it => ({ norm: it.feat ? it.feat.subarray(0, DIG.GW * DIG.GH) : null })).filter(x => x.norm)
              if (norms.length) await tgSendText('Что я вижу (ASCII, раунд ' + round + '):\n```\n' + asciiRow(norms) + '\n```')
            } catch (e) {}
            tgLog('/glyphs раунд ' + round + ': отправлено ' + items.length + ' кропов' + (cmdArg ? ' + аргумент «' + cmdArg.slice(0, 20) + '»' : ''))
            // «/glyphs 82502» — человек сразу дал и ответ: идём размечать, не continue
            const argDigits = cmdArg.replace(/[^0-9]/g, '')
            if (argDigits.length === DIGITS_EXPECTED) { argText = argDigits; tgLog('раунд ' + round + ': цифры из аргумента /glyphs → «' + argDigits + '»') }
            else continue
          }
          if (cmdOk && cmd === '/diag') {
            // полная диагностика сегментации: файлы + топ стратегий + ASCII кропы
            await tgSendText('🔎 Готовлю диагностику раунда ' + round + '…')
            const lines = []
            lines.push('🧩 ДИАГНОСТИКА раунда ' + round)
            lines.push('стратегия: ' + (rec.segStrategy || 'запасной метод') + ' | балл: ' + rec.segScore +
              ' | путь: ' + (rec.segPath || '?'))
            lines.push('одинаковых кропов: ' + Math.round((rec.segSameFrac || 0) * 100) + '% пар' +
              (rec.segDegenerate ? '  🧨 ВЫРОЖДЕНИЕ — маска режет не цифры' : ''))
            lines.push('равномерная нарезка (рамки «на глазок»): ' + (rec.segFallback ? 'ДА ⚠️' : 'нет'))
            lines.push('плотность штриха (медиана): ' + rec.segMedStroke + ' | чернил на картинке: ' + rec.inkDensity)
            lines.push('каталог: ' + (rec.dir || '?'))
            lines.push('')
            lines.push('Топ стратегий на этой картинке (балл / черн.% / одинак.кропы):')
            try {
              const img = loadRawImage(rec.dir)
              if (img) {
                const all = DIG.autoSegment(img.data, img.W, img.H, DIGITS_EXPECTED, {}) || []
                for (const r2 of all.slice(0, 8)) {
                  const cr = cropsFromSegResult(r2, img.W, img.H, DIGITS_EXPECTED)
                  let sf = '—'
                  if (cr) {
                    let sp = 0, tp = 0
                    for (let i = 0; i < cr.length; i++) for (let j = i + 1; j < cr.length; j++) {
                      tp++
                      let d = 0
                      for (let t = 0; t < DIG.GW * DIG.GH; t++) { const x = cr[i].norm[t] - cr[j].norm[t]; d += x * x }
                      if (Math.sqrt(d) < 1.2) sp++
                    }
                    sf = Math.round(100 * sp / Math.max(1, tp)) + '%'
                  }
                  lines.push('  ' + String(r2.score).padStart(6) + '  ' + String(Math.round(r2.inkFrac * 1000) / 10).padStart(5) +
                    '  ' + String(sf).padStart(5) + '   ' + r2.name + (r2.fallback ? ' [равномерная]' : ''))
                }
                // ASCII лучшей стратегии — видно, цифра в кропе или шум
                const bestRes = all[0]
                const cr = bestRes ? cropsFromSegResult(bestRes, img.W, img.H, DIGITS_EXPECTED) : null
                if (cr) { lines.push(''); lines.push('Кропы лучшей стратегии «' + bestRes.name + '»:'); lines.push(asciiRow(cr)) }
                for (const r2 of all.slice(0, 2)) {
                  try {
                    const p2 = debugSegmentationPng({ data: img.data, W: img.W, H: img.H }, r2.boxes, r2.band)
                    if (p2) { fs.writeFileSync(path.join(rec.dir, 'DIAG_tg_' + r2.name.replace(/[^a-z0-9_.+-]/gi, '_') + '.png'), p2); await tgSendPhoto(p2, 'Рамки стратегии «' + r2.name + '» (раунд ' + round + ')') }
                  } catch (e) {}
                }
              } else lines.push('  (не удалось прочитать ORIGINAL_raw.bin из ' + rec.dir + ')')
            } catch (e) { lines.push('  ошибка: ' + e.message) }
            const txt = lines.join('\n')
            await tgSendText(txt.length > 3800 ? txt.slice(0, 3800) + '\n…(обрезано)' : txt)
            tgLog('/diag раунд ' + round + ': стратегия=' + (rec.segStrategy || '?') + ' одинаковых=' +
              Math.round((rec.segSameFrac || 0) * 100) + '% degenerate=' + !!rec.segDegenerate)
            continue
          }
          if (cmdOk && cmd === '/yolo') {
            if (!YOLO.enabled) { await tgSendText('🌐 YOLO API выключен (yolo.enabled=false) — работаем локальной моделью'); continue }
            await tgSendText('🌐 Проверяю YOLO API на картинке раунда ' + round + '…')
            yoloReset()
            const t0 = Date.now()
            const rr = await yoloRecognize(png, 'команда /yolo')
            const rep = rr
              ? ('✅ YOLO ответил: «' + rr.digits + '»' + (rr.exact ? '' : ' ⚠️ не ' + DIGITS_EXPECTED + ' цифр') +
                 '\nСервер: ' + rr.host + ' (' + rr.field + '), ' + rr.ms + 'мс\nЛокальная модель: «' + (pred || '—') + '»')
              : '❌ YOLO API не ответил за ' + Math.round((Date.now() - t0) / 1000) + 'с.\nПроверялись: ' + YOLO.urls.join('\n') +
                '\n\nРаботаем локальной моделью. Свой сервер: python yolo_server.py'
            await tgSendText(rep)
            tgLog('/yolo: ' + (rr ? 'ответ «' + rr.digits + '» от ' + rr.host : 'нет ответа'))
            continue
          }
          if (cmdOk && cmd === '/train') {
            const r = trainModel(store)
            if (!r.ok) { await tgSendText('⚠️ ' + r.reason + '. Нужно ≥20 примеров.'); continue }
            model = r.mlp
            st.lastModelInfo = r.accTrain + '% train / ' + r.accTest + '% holdout (' + r.ms + 'мс, ' + r.samples + ' примеров)'
            await tgSendText('🧠 MLP обучена: ' + st.lastModelInfo + '\n' + JSON.stringify(r.counts))
            tgLog('/train: ' + st.lastModelInfo)
            continue
          }
          if (items.length !== DIGITS_EXPECTED && !/^\//.test(low) && argText.replace(/[^0-9]/g, '').length !== DIGITS_EXPECTED) {
            await tgSendText('⚠️ На этой картинке я нашёл ' + items.length + ' цифр из ' + DIGITS_EXPECTED +
              ' — размечать нечего. Пришлите /skip, чтобы перейти к следующей.\n' +
              'Для диагностики: файл debug_segmentation.png в папке раунда (на нём рамки, которые я нашёл).')
            tgLog('раунд ' + round + ': найдено ' + items.length + ' цифр из ' + DIGITS_EXPECTED + ' — жду /skip')
            continue
          }
          if (cmdOk && cmd === '/skip') {
            st.skipped++
            if (cmdArg) {
              appendAnswer({ round, answer: null, ts: new Date().toISOString(), src: 'skip', dir: rec.dir ? path.basename(rec.dir) : null,
                note: cmdArg.slice(0, 200), digits: items.length, seg: { strategy: rec.segStrategy || null, degenerate: !!rec.segDegenerate } })
              tgLog('раунд ' + round + ': /skip с пояснением «' + cmdArg.slice(0, 60) + '» (записано в answers.jsonl)')
            }
            await tgSendText('⏭ Раунд ' + round + ' пропущен. Счётчик совпадений сброшен (' + st.streak + ' → 0)')
            st.streak = 0
            answered = true
            break
          }

          // ---------- цифры ----------
          let digits = ''
          if (argText === '+' || low === 'да' || low === 'ok' || low === 'верно' || low === 'y') {
            if (!botAnswer) {
              await tgSendText('⚠️ Подтверждать нечего: ни YOLO, ни локальная модель не дали ' + DIGITS_EXPECTED +
                ' цифр (локально «' + (pred || 'нет') + '», найдено ' + items.length + ' из ' + DIGITS_EXPECTED +
                ').\nПришлите цифры вручную или /glyphs')
              continue
            }
            digits = botAnswer
          } else {
            digits = argText.replace(/[^0-9]/g, '')
          }
          if (!digits) { await tgSendText('Не понял. Пришлите ровно ' + DIGITS_EXPECTED + ' цифр (например 48152), «+», /skip или /help'); continue }
          if (digits.length !== DIGITS_EXPECTED) {
            await tgSendText('⚠️ Нужно ровно ' + DIGITS_EXPECTED + ' цифр, а пришло ' + digits.length + ' («' + digits + '»). Повторите или /skip')
            continue
          }

          // ---------- сравнение с предсказанием + обучение ----------
          const match = !!botAnswer && botAnswer === digits
          if (match) { st.streak++; st.matches++ } else { st.mismatches++; st.streak = 0 }
          if (!complete) st.incomplete++
          if (yoloOk && yoloDigits === digits) st.yoloHits = (st.yoloHits || 0) + 1
          st.bestStreak = Math.max(st.bestStreak, st.streak)

          // ответ человека = истина → в базу (даже если бот угадал).
          // НО: если кропы выродились (все 5 почти одинаковые — «88888»), в базу
          // такое класть НЕЛЬЗЯ: признаки описывают шум, модель запоминает шум
          // (реальный лог: train 84% / holdout 10%, 270 примеров впустую).
          const recFresh = Object.assign({}, rec, { digitItems: items })
          const degenerate = !!rec.segDegenerate
          const res = degenerate
            ? { ok: false, reason: 'кропы одинаковые (' + Math.round((rec.segSameFrac || 0) * 100) + '% пар) — маска не по цифрам', degenerate: true }
            : labelRoundWithDigits(store, recFresh, round, digits)
          if (degenerate) tgLog('раунд ' + round + ': ⚠️ ОТКАЗ от разметки — сегментация выродилась (стратегия ' +
            (rec.segStrategy || '?') + ', балл ' + rec.segScore + ', одинаковых пар ' + Math.round((rec.segSameFrac || 0) * 100) +
            '%). Ответ «' + digits + '» сохранён в answers.jsonl для --autotune.')
          // ЗОЛОТАЯ РАЗМЕТКА: ответ человека сохраняем ВСЕГДА (даже если вырезать
          // глифы не удалось) — по нему офлайн подбирается маска: --autotune
          appendAnswer({
            round, answer: digits, ts: new Date().toISOString(), src: 'tg',
            dir: rec.dir ? path.basename(rec.dir) : null, capFile: rec.capFile || null,
            labeled: res.ok ? res.n : 0, reason: res.ok ? null : res.reason,
            bot: botAnswer || null, botSrc, yolo: yoloDigits || null, local: pred || null,
            seg: { strategy: rec.segStrategy || null, score: rec.segScore || null, path: rec.segPath || null }
          })
          let rep
          if (res.ok) {
            st.labeled += res.n
            st.newLabels += res.n
            st.variants = (st.variants || 0) + (res.variants || res.n)
            const dropped = dropQueueRound(round)
            rep = (match
              ? '✅ СОВПАЛО! Я (' + botSrc + '): ' + botAnswer + ' = Вы: ' + digits
              : '❌ Я (' + botSrc + ') сказал «' + (botAnswer || '—') + '», верно «' + digits + '»' +
                (yoloOk && yoloDigits !== digits ? '  [YOLO тоже ошибся: ' + yoloDigits + ']' : '')) +
              '\n🎯 Подряд: ' + st.streak + '/' + TG.targetStreak + (st.bestStreak > st.streak ? ' (рекорд ' + st.bestStreak + ')' : '') +
              '\n📚 Размечено ' + res.n + ' цифр (с аугментацией ' + (res.variants || res.n) + ' примеров) → база ' + store.size + (dropped ? ' (из очереди убрано ' + dropped + ')' : '')
            tgLog('раунд ' + round + ': ' + (match ? 'СОВПАЛО' : 'НЕ СОВПАЛО') + ' бот(' + botSrc + ')="' + botAnswer +
              '" локально="' + pred + '" yolo="' + yoloDigits + '" человек="' + digits +
              '" streak=' + st.streak + '/' + TG.targetStreak + ' размечено=' + res.n + ' база=' + store.size)
          } else {
            st.streak = 0
            st.degenerate = (st.degenerate || 0) + (res.degenerate ? 1 : 0)
            rep = '⚠️ Разметить не удалось: ' + res.reason + ' (вырезано ' + items.length + ' из ' + DIGITS_EXPECTED + ').\n' +
              (res.degenerate
                ? '🧨 Маска режет НЕ цифры: все ' + DIGITS_EXPECTED + ' кропов почти одинаковые. Дальше учиться бессмысленно — база будет мусорной.\n' +
                  'Что сделать: пришлите /diag (я покажу, что именно вырезал), затем на ПК:\n' +
                  '  node main.js --import-answers learn\\telegram.log\n' +
                  '  node main.js --autotune --apply\n' +
                  'Автоподбор переберёт ~50 масок на уже сохранённых картинках и выберет ту, где цифры действительно узнаются.'
                : 'Пришлите /glyphs — посмотрим, что я режу не так.') +
              '\nСчётчик сброшен.'
            tgLog('раунд ' + round + ': разметка не удалась (' + res.reason + '), вырезано ' + items.length + ' из ' + DIGITS_EXPECTED)
          }

          // ---------- автообучение ----------
          if (TG.autoTrainEvery && st.newLabels >= TG.autoTrainEvery && store.size >= 30) {
            const r = trainModel(store)
            st.newLabels = 0
            if (r.ok) {
              model = r.mlp
              st.lastModelInfo = r.accTrain + '% train / ' + r.accTest + '% holdout (' + r.ms + 'мс, ' + r.samples + ')'
              rep += '\n🧠 автообучение MLP: ' + st.lastModelInfo
              tgLog('автообучение MLP: ' + st.lastModelInfo)
            } else tgLog('автообучение пропущено: ' + r.reason)
          }

          // ---------- цель достигнута? ----------
          if (st.streak >= TG.targetStreak) {
            st.stop = true
            st.doneByStreak = true
            await finishSession(st, store, '🎓 ОБУЧЕНИЕ ЗАВЕРШЕНО — ' + st.streak + ' совпадений подряд!')
            break
          }

          const nxt = q.size
          rep += '\n' + (nxt ? '⏩ Следующая картинка уже готова (' + nxt + ' в очереди)' : '⏳ готовлю следующую…')
          await tgSendText(rep)
          answered = true
        }
      }
    } catch (e) {
      st.stop = true
      tgLog('❌ потребитель упал: ' + ((e && e.stack) || (e && e.message) || e))
      try { await tgSendText('❌ Внутренняя ошибка сессии: ' + ((e && e.message) || e) + '\nПодробности: ' + tgLogFile()) } catch (e2) {}
    } finally {
      // обязательно освобождаем производителя, иначе он останется ждать места в очереди
      st.stop = true
      try { q.close() } catch (e2) {}
    }
  })()

  await Promise.all([producer, consumer])
  q.close()
  if (!st.doneByStreak && !st.stop) await finishSession(st, store, '🏁 Раунды закончились')
  else if (st.stop && !st.doneByStreak) tgLog('сессия остановлена (не по цели): раундов=' + st.rounds + ' streak=' + st.streak)
  return { ok: true, st }
}

// итоговое сообщение + финальное обучение модели
async function finishSession(st, store, headline) {
  let modelInfo = st.lastModelInfo || ''
  try {
    const r = trainModel(store)
    if (r.ok) {
      modelInfo = r.accTrain + '% train / ' + r.accTest + '% holdout (' + r.samples + ' примеров, ' + r.ms + 'мс)'
      st.lastModelInfo = modelInfo
      tgLog('финальное обучение MLP: ' + modelInfo)
    } else tgLog('финальное обучение пропущено: ' + r.reason)
  } catch (e) { tgLog('finishSession train err: ' + e.message) }
  const txt = headline + '\n' +
    'Раундов: ' + st.rounds + ' | размечено глифов: ' + st.labeled + ' | пропущено: ' + st.skipped + '\n' +
    'Совпало: ' + st.matches + ' | не совпало: ' + st.mismatches + ' | рекорд подряд: ' + st.bestStreak + '\n' +
    'База: ' + store.size + ' ' + JSON.stringify(store.counts()) +
    (modelInfo ? '\n🧠 MLP: ' + modelInfo : '') + '\n' +
    'Лог: ' + tgLogFile()
  await tgSendText(txt)
  tgLog('сессия завершена: раундов=' + st.rounds + ' размечено=' + st.labeled + ' совпало=' + st.matches +
    ' не совпало=' + st.mismatches + ' рекорд=' + st.bestStreak + ' база=' + store.size)
  step('=== TELEGRAM-СЕССИЯ: ' + headline.replace(/\n/g, ' ') + ' | раундов ' + st.rounds +
    ' | размечено ' + st.labeled + ' | совпало ' + st.matches + '/' + (st.matches + st.mismatches) +
    ' | рекорд подряд ' + st.bestStreak + ' | база ' + store.size + ' ===')
}

// Долгое ожидание сообщения (long polling).
// ВАЖНО: Telegram вместе с ответом может прислать несколько апдейтов сразу.
// offset подтверждает ВСЕ полученные, поэтому непрочитанные обязательно
// складываем в локальный буфер st.pending — иначе сообщение теряется и бот зависает.
async function tgWaitMessage(st) {
  if (!st.pending) st.pending = []
  while (!st.stop) {
    if (st.pending.length) return st.pending.shift()
    const r = await tgApi('getUpdates', { offset: st.offset, timeout: 25, allowed_updates: ['message'] }, null, 45000)
    if (!r.ok) {
      tgLog('getUpdates ошибка: ' + (r.description || r.error_code) + ' — повтор через 3с')
      await sleep(3000)
      continue
    }
    let got = 0
    for (const u of (r.result || [])) {
      st.offset = Math.max(st.offset, u.update_id + 1)
      const msg = u.message
      if (!msg) continue
      if (String(msg.chat && msg.chat.id) !== String(TG.chatId)) {
        tgLog('игнорирую сообщение из чата ' + (msg.chat && msg.chat.id) + ' (нужен ' + TG.chatId + ')')
        continue
      }
      // вторая линия защиты от «призраков»: сообщение старше старта сессии не обрабатываем
      if (st.startedAt && msg.date && msg.date < st.startedAt - 30) {
        tgLog('игнорирую старое сообщение (date=' + msg.date + ', сессия началась ' + st.startedAt + '): «' +
          String(msg.text || '').slice(0, 40) + '»')
        continue
      }
      msg.update_id = u.update_id
      st.pending.push(msg)
      got++
    }
    if (got > 1) tgLog('получено сразу ' + got + ' сообщений — ' + (got - 1) + ' в буфере')
  }
  return null
}

// ========================= ДИАГНОСТИКА TELEGRAM =========================
async function runTgTest() {
  console.log('=== ПРОВЕРКА TELEGRAM ===')
  console.log('apiUrl     : ' + TG.apiUrl)
  console.log('token      : ' + (TG.token ? TG.token.slice(0, 8) + '...' + TG.token.slice(-4) + ' (длина ' + TG.token.length + ')' : 'НЕ ЗАДАН'))
  console.log('chatId     : ' + (TG.chatId || 'НЕ ЗАДАН'))
  const sp = parseSocksUrl(TG.socksUrl)
  console.log('спец-прокси: ' + (TG.socksUrl ? TG.socksUrl.replace(/:([^:@/]+)@/, ':***@') + '  (ключ ' + TG.socksKey + ')' : 'не задан') +
    (TG.socksUrl ? (sp ? '  → распознан: socks' + sp.type + ' ' + sp.host + ':' + sp.port + (sp.username ? ' логин=' + sp.username : '') : '  → ⚠️ НЕ РАСПОЗНАН (формат: socks5://логин:пароль@хост:порт)') : ''))
  console.log('MC-прокси  : ' + (PROXY.host ? PROXY.host + ':' + PROXY.port + ' (резерв)' : 'нет') + ' | useMcProxy=' + TG.useMcProxy)
  console.log('')
  if (!TG.token) { console.log('❌ нет telegram.token — нечего проверять'); return false }

  let working = null
  for (const tr of tgTransports()) {
    const name = tr === 'direct' ? 'direct' : tr.name
    const savedTransport = tgTransport
    tgTransport = tr
    const t0 = Date.now()
    const r = await tgApi('getMe', null, null, TG.probeTimeoutMs, tr)   // только этот транспорт
    const ms = Date.now() - t0
    tgTransport = savedTransport
    if (r.ok) {
      console.log('✅ ' + name + ': ОК за ' + ms + 'мс — бот @' + (r.result && r.result.username) + ' (id ' + (r.result && r.result.id) + ')')
      working = { tr, name, bot: r.result }
      break
    } else {
      const d = String(r.description || r.error_code || 'ошибка')
      console.log('❌ ' + (d.indexOf(name + ':') === 0 ? d : name + ': ' + d) + ' (' + ms + 'мс)')
    }
  }
  if (!working) {
    console.log('')
    console.log('Ни один транспорт не дошёл до api.telegram.org.')
    console.log('Что делать:')
    console.log('  1) задать рабочий SOCKS в config.json:  "telegram": { "apiProxy": "socks5://логин:пароль@хост:порт" }')
    console.log('  2) проверить, что прокси живой и пускает на 443 порт')
    console.log('  3) если Telegram доступен напрямую — "telegram": { "preferSocks": false }')
    tgTransport = null
    return false
  }
  tgTransport = working.tr
  console.log('')
  console.log('Рабочий транспорт: ' + working.name + ' — он будет использоваться для всех запросов.')
  const msg = await tgApi('sendMessage', { chat_id: TG.chatId, text: '✅ Связь есть. Транспорт: ' + working.name + '\nБот @' + (working.bot && working.bot.username) + ' готов к разметке капчи.' }, null, TG.probeTimeoutMs)
  if (msg.ok) console.log('✅ тестовое сообщение отправлено в chat_id=' + TG.chatId + ' (message_id=' + (msg.result && msg.result.message_id) + ')')
  else console.log('❌ сообщение не отправилось: ' + (msg.description || msg.error_code) + ' — проверьте chatId (узнать: @userinfobot) и что вы написали боту /start')
  return msg.ok
}

// ========================= ОБУЧЕНИЕ ЦИФР =========================
function runLabelTool() {
  const readline = require('readline')
  const store = new DIG.GlyphStore(LEARN_DIR)
  const queue = new DIG.LabelQueue(LEARN_DIR)

  const rewriteStore = () => {
    try {
      const lines = store.samples.map(s => JSON.stringify({ id: s.id, digit: s.digit, f: DIG.f32ToB64(s.feat), src: s.src || '', ts: new Date().toISOString() }))
      fs.mkdirSync(LEARN_DIR, { recursive: true })
      fs.writeFileSync(path.join(LEARN_DIR, 'glyphs.jsonl'), lines.join('\n') + (lines.length ? '\n' : ''))
    } catch (e) { console.error('rewriteStore err:', e.message) }
  }

  console.log('=== РАЗМЕТКА ГЛИФОВ КАПЧИ ===')
  console.log('База: ' + LEARN_DIR)
  console.log('Уже размечено: ' + store.size + ' ' + JSON.stringify(store.counts()))
  console.log('В очереди: ' + queue.size)
  if (!queue.size) {
    console.log('')
    console.log('Очередь пуста. Сначала соберите капчу (node main.js) или пересоберите старые')
    console.log('записи (node main.js --replay-all records), затем вернитесь сюда.')
    return
  }
  console.log('')
  console.log('Управление: 0..9 — метка | s — пропустить | x — удалить | u — отменить | q — выйти и сохранить')
  console.log('')

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const asked = []
  let labeled = 0, skipped = 0, removed = 0, pos = 0

  function finish() {
    rl.close()
    console.log('')
    console.log('=== ИТОГ ===')
    console.log('размечено: ' + labeled + ' | пропущено: ' + skipped + ' | удалено: ' + removed)
    console.log('в базе: ' + store.size + ' ' + JSON.stringify(store.counts()))
    console.log('осталось в очереди: ' + queue.size)
    console.log(store.size >= 20 ? 'Можно обучить нейросеть: node main.js --train'
      : 'Для обучения MLP нужно ≥20 примеров (лучше 100+). k-NN работает уже сейчас.')
    setTimeout(() => process.exit(0), 100)
  }
  function ask() { rl.question('цифра (0-9 / s / x / u / q): ', answer) }
  function show() {
    if (pos >= queue.items.length) { finish(); return }
    const it = queue.items[pos]
    let norm
    try { norm = DIG.b64ToF32(it.f).subarray(0, DIG.GW * DIG.GH) } catch (e) { pos++; show(); return }
    console.log('───── ' + (pos + 1) + ' / ' + queue.items.length + ' ───── id=' + it.id +
      (it.round ? ' раунд=' + it.round : '') + (it.wall ? ' стена=' + it.wall : '') +
      (it.bbox ? ' размер=' + it.bbox.w + '×' + it.bbox.h : '') +
      (it.guess !== null && it.guess !== undefined ? ' догадка=' + it.guess + ' (уверенность ' + (it.conf || 0) + ')' : ''))
    console.log(DIG.asciiArt(norm))
    if (it.png) console.log('файл: ' + it.png)
    ask()
  }
  function answer(a) {
    a = String(a || '').trim().toLowerCase()
    if (a === 'q') { finish(); return }
    const it = queue.items[pos]
    if (!it) { finish(); return }
    if (/^[0-9]$/.test(a)) {
      store.addAugmented(Number(a), DIG.b64ToF32(it.f), { src: (it.src || '') + '#' + it.id })
      asked.push({ pos, id: it.id, item: it })
      queue.items.splice(pos, 1); queue.save()
      labeled++
      console.log('  ✓ записано как ' + a + ' + аугментация → в базе ' + store.size + ' примеров')
      show(); return
    }
    if (a === 's') { pos++; skipped++; console.log('  → пропущен'); show(); return }
    if (a === 'x') { queue.items.splice(pos, 1); queue.save(); removed++; console.log('  ✗ удалён из очереди'); show(); return }
    if (a === 'u') {
      const last = asked.pop()
      if (!last) { console.log('  нечего отменять'); show(); return }
      const i = store.samples.findIndex(s => s.src && s.src.endsWith('#' + last.id))
      if (i >= 0) { store.samples.splice(i, 1); rewriteStore() }
      queue.items.splice(Math.min(last.pos, queue.items.length), 0, last.item)
      queue.save()
      pos = Math.min(last.pos, queue.items.length - 1)
      labeled = Math.max(0, labeled - 1)
      console.log('  ↩ отменено')
      show(); return
    }
    console.log('  ? введите 0-9, s, x, u или q')
    ask()
  }
  show()
}

function runTrain() {
  if (!DIG) { console.error('digits.js не загружен'); process.exit(1) }
  const store = new DIG.GlyphStore(LEARN_DIR)
  const counts = store.counts()
  console.log('=== Обучение MLP ===')
  console.log('База: ' + store.size + ' глифов ' + JSON.stringify(counts))
  if (store.size < 20) {
    console.log('Мало данных. Сначала разметьте глифы: node main.js --label (нужно хотя бы 20, лучше 100+)')
    process.exit(1)
  }
  const missing = []
  for (let d = 0; d <= 9; d++) if (!counts[d]) missing.push(d)
  if (missing.length) console.log('⚠️ нет примеров для цифр: ' + missing.join(','))

  // перемешиваем и держим 20% на контроле
  const idx = [...Array(store.size).keys()]
  for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = idx[i]; idx[i] = idx[j]; idx[j] = t }
  const nTest = Math.max(1, Math.floor(idx.length * 0.2))
  const testIdx = idx.slice(0, nTest), trainIdx = idx.slice(nTest)
  const X = a => a.map(i => Array.from(store.samples[i].feat))
  const Y = a => a.map(i => store.samples[i].digit)

  const t0 = Date.now()
  const mlp = new DIG.MLP(DIG.FEAT_DIM, Number(cfgGet(CFG, 'digits.hidden', 20)) || 20, 10)
  const hist = mlp.train(X(trainIdx), Y(trainIdx), {
    epochs: Number(cfgGet(CFG, 'digits.epochs', 150)) || 150, batch: 8, lr: 0.03
  })
  const sec = ((Date.now() - t0) / 1000).toFixed(1)
  const accTrain = mlp.accuracy(X(trainIdx), Y(trainIdx))
  const accTest = mlp.accuracy(X(testIdx), Y(testIdx))
  console.log('Обучение: ' + sec + 'с, loss ' + hist[0].loss + ' → ' + hist[hist.length - 1].loss)
  console.log('Точность: train ' + accTrain + '% | holdout(' + nTest + ') ' + accTest + '%')

  // сравнение с k-NN на той же контрольной выборке
  const sub = new DIG.GlyphStore(LEARN_DIR)
  sub.samples = trainIdx.map(i => store.samples[i])
  let okKnn = 0
  for (const i of testIdx) { const r = sub.classify(store.samples[i].feat, 5); if (r && r.digit === store.samples[i].digit) okKnn++ }
  console.log('Для сравнения k-NN на holdout: ' + Math.round(1000 * okKnn / nTest) / 10 + '%')

  if (mlp.save(LEARN_DIR)) console.log('✅ модель сохранена: ' + path.join(LEARN_DIR, 'model.json'))
  else { console.log('❌ не удалось сохранить модель'); process.exit(1) }
  if (accTest < accTrain - 20) console.log('⚠️ похоже на переобучение — добавьте примеров (node main.js --label)')
}

// пересобрать ВСЕ записи в каталоге (удобно для уже накопленных раундов:
// заодно наполняет очередь глифов для разметки — без новых подключений к серверу)
async function replayAll(root) {
  if (!fs.existsSync(root)) { step('каталог не найден: ' + root); return 0 }
  const dirs = fs.readdirSync(root, { withFileTypes: true })
    .filter(d => d.isDirectory() && /^round\d+/.test(d.name))
    .map(d => path.join(root, d.name))
    .sort()
  if (!dirs.length) { step('в ' + root + ' нет каталогов roundNN_*'); return 0 }
  step('REPLAY-ALL: найдено записей: ' + dirs.length)
  let ok = 0
  const rows = []
  for (const d of dirs) {
    if (!fs.existsSync(path.join(d, 'frames.json'))) { step('  пропускаю (нет frames.json): ' + path.basename(d)); continue }
    const rp = replayDir(d)
    if (!rp) continue
    const num = (path.basename(d).match(/^round(\d+)/) || [])[1]
    const rec = await saveRecord(rp.out, rp.snap, 'REPLAY ' + path.basename(d), num ? Number(num) : null)
    if (rec) { ok++; rows.push('  ' + path.basename(d) + ' → ' + rec.cols + '×' + rec.rows + ' стена=' + rec.wall + ' seam=' + rec.seamCost + ' ПРЕДСКАЗАНИЕ="' + (rec.prediction || '') + '" (уверенные "' + rec.digits + '")') }
    else rows.push('  ' + path.basename(d) + ' → НЕ СОБРАЛОСЬ')
  }
  step('REPLAY-ALL готово: ' + ok + '/' + dirs.length)
  console.log(rows.join('\n'))
  try {
    const q = DIG ? new DIG.LabelQueue(LEARN_DIR) : null
    if (q) step('В очереди на разметку: ' + q.size + ' глифов → node main.js --label')
  } catch (e) {}
  return ok
}

// один раунд: попытки, ротация IP, сохранение. Общий для обычного и Telegram-режима.
async function captureRound(r, ctx) {
  let rec = null, lastNetFail = null, lastNote = ''
  for (let attempt = 1; attempt <= ATTEMPTS_PER_ROUND && !rec && !ctx.aborted; attempt++) {
    if (attempt > 1 && (lastNetFail || ctx.consecutiveNetFails > 0) && ctx.rotationsUsed < MAX_ROTATIONS_ON_FAIL) {
      ctx.rotationsUsed++
      step('🔄 ротация IP (' + ctx.rotationsUsed + '/' + MAX_ROTATIONS_ON_FAIL + ')')
      await rotateIp(); await sleep(2500)
    } else if (attempt > 1) await sleep(FAST_MODE ? 300 : 1500)
    else await sleep(FAST_MODE ? (FAST.preSleepMin + Math.floor(Math.random() * FAST.preSleepRnd)) : (1000 + Math.floor(Math.random() * 1000)))

    step('--- РАУНД ' + r + (TG.ready ? '' : '/' + TARGET_ROUNDS) + ' (попытка ' + attempt + ', IP ' + (currentRunIp || '?') +
      (FAST_MODE ? ', FAST' : '') + ') ---')
    const tNet = Date.now()
    const res = await connectAndCapture('r' + r + 'a' + attempt)
    const netMs = Date.now() - tNet
    lastNetFail = !!(res && !res.ok && NET_FAIL_RE.test(res.note || ''))
    lastNote = res ? res.note : '?'

    if (res && res.ok) {
      ctx.consecutiveNetFails = 0; ctx.proxyFails = 0
      const dir = path.join(REC_ROOT, 'round' + String(r).padStart(2, '0') + '_a' + attempt + '_' + STAMP)
      const tSave = Date.now()
      const candidate = await saveRecord(dir, res.snap, 'РАУНД' + r, r, { light: FAST_MODE && FAST.lightFiles })
      ctx.lastTimings = { net: netMs, save: Date.now() - tSave }
      // YOLO API: основной распознаватель (85-91%), локальная модель учится на ответах
      if (candidate && YOLO.enabled) {
        try {
          const png = fs.readFileSync(candidate.pngFile)
          const t0 = Date.now()
          candidate.yolo = await yoloRecognize(png, 'РАУНД' + r)
          ctx.lastTimings.yolo = Date.now() - t0
        } catch (e) { dbg('yolo err ' + e.message) }
      }
      if (candidate) {
        const need = Math.max(CAP.minTiles, Math.ceil(candidate.tilesExpected * MIN_TILES_FRACTION))
        if (candidate.tilesCount >= Math.min(need, candidate.tilesExpected)) rec = candidate
        else step('РАУНД ' + r + ': мало плиток ' + candidate.tilesCount + '/' + candidate.tilesExpected + ' (нужно ' + need + ')')
      }
    } else {
      step('раунд ' + r + ' попытка ' + attempt + ': ' + lastNote)
      if (FATAL_RE.test(lastNote)) {
        ctx.aborted = true
        step('❌ ФАТАЛЬНО: ' + lastNote + ' — дальнейшие попытки бессмысленны')
      } else if (PROXY_DEAD_RE.test(lastNote)) {
        ctx.proxyFails++
        if (ctx.proxyFails >= 2) { ctx.proxyDead = true; ctx.aborted = true; step('ПРОКСИ МЁРТВ') }
      } else if (lastNetFail) {
        if (currentRunIp) badIPs.add(currentRunIp)
        ctx.consecutiveNetFails++
        if (ctx.consecutiveNetFails >= 6) { ctx.aborted = true; step('6 сетевых фейлов подряд') }
      } else ctx.consecutiveNetFails = 0
    }
  }
  if (rec) {
    ctx.results.push({ n: r, ok: true, rec })
    step('РАУНД ' + r + ' ✅ ' + rec.cols + '×' + rec.rows + ' tiles=' + rec.tilesCount + '/' + rec.tilesExpected +
      ' ori=' + rec.ori + ' rot=' + rec.rotRule + ' seam=' + rec.seamCost +
      ' YOLO="' + (rec.yolo ? rec.yolo.digits : '-') + '"' +
      ' ЛОКАЛЬНО="' + (rec.prediction || '') + '"' +
      (rec.capFile ? ' → records/captchas/' + rec.capFile : ''))
  } else if (!ctx.aborted) {
    ctx.results.push({ n: r, ok: false, note: lastNote || 'fail' })
    step('РАУНД ' + r + ' ❌ провален (' + (lastNote || 'fail') + ')')
  }
  // причина провала — для telegram.log (иначе в чате «картинка не собралась» без деталей)
  ctx.lastNote = rec ? '' : (lastNote || 'не удалось собрать стену/плитки')
  ctx.lastAttempts = ATTEMPTS_PER_ROUND
  ctx.lastFail = rec ? '' : (lastNote || 'fail')
  if (!ctx.aborted) await sleep(FAST_MODE ? FAST.pauseBetween : PAUSE_BETWEEN_MS)
  return rec
}

// обычный режим: просто собрать N раундов
async function runClassic(ctx) {
  for (let r = 1; r <= TARGET_ROUNDS && !ctx.aborted; r++) await captureRound(r, ctx)
}

// ========================= MAIN =========================
async function main() {
  step('=== СТАРТ v3.13.0 ===')

  if (CLI.selftest) { process.exit((await selftest()) ? 0 : 1) }
  if (CLI.tgTest) { const ok = await runTgTest(); setTimeout(() => process.exit(ok ? 0 : 1), 300); return }
  if (CLI.yoloTest) {
    const f = CLI.yoloTest
    if (!fs.existsSync(f)) { step('файл не найден: ' + f); process.exit(1) }
    step('YOLO-тест файла ' + f + ' (' + fs.statSync(f).size + ' байт)')
    step('эндпоинты: ' + YOLO.urls.join(' → '))
    const t0 = Date.now()
    const r = await yoloRecognize(fs.readFileSync(f), 'тест')
    if (r) step('✅ ответ: «' + r.digits + '» от ' + r.host + ' [' + r.field + '] за ' + r.ms + 'мс (всего ' + (Date.now() - t0) + 'мс)')
    else step('❌ ни один эндпоинт не ответил. Поднимите свой: python yolo_server.py')
    setTimeout(() => process.exit(r ? 0 : 1), 300)
    return
  }
  if (CLI.proxyCheck) {
    step('config: ' + (CFG_PATH || 'НЕТ') + ' parse=' + CFG_STRATEGY)
    const ok = await runProxyCheck()
    setTimeout(() => process.exit(ok ? 0 : 1), 300)
    return
  }
  if (CLI.label) { runLabelTool(); return }
  if (CLI.train) { runTrain(); return }

  // офлайн-разбор уже сохранённых картинок (без подключения к серверу)
  if (CLI.importAnswers) {
    const r = importAnswersFromFile(CLI.importAnswers)
    step('всего ответов в learn/answers.jsonl: ' + r.total)
    setTimeout(() => process.exit(r.ok ? 0 : 1), 200)
    return
  }
  if (CLI.diag) { runDiag(CLI.diagDir || ''); setTimeout(() => process.exit(0), 200); return }
  if (CLI.autotune) {
    const r = await runAutotune(CLI.autotuneDir, { apply: CLI.apply })
    setTimeout(() => process.exit(r && r.ok ? 0 : 1), 200)
    return
  }

  if (CLI.replayAll) {
    const n = await replayAll(CLI.replayAll)
    setTimeout(() => process.exit(n ? 0 : 1), 300)
    return
  }

  if (CLI.replay) {
    const rp = replayDir(CLI.replay)
    if (!rp) process.exit(1)
    const rec = await saveRecord(rp.out, rp.snap, 'REPLAY', null)
    step(rec ? 'REPLAY OK: ' + rec.wall + ' ' + rec.cols + '×' + rec.rows + ' → ' + rp.out : 'REPLAY FAIL')
    setTimeout(() => process.exit(rec ? 0 : 1), 300)
    return
  }

  if (!CFG_PATH && !CLI.replay && !CLI.replayAll) { step('НЕ НАЙДЕН config.json'); process.exit(1) }
  step('config: ' + CFG_PATH + ' parse=' + CFG_STRATEGY)
  step('MC: ' + MC.host + ':' + MC.port + ' v' + MC.version + ' | прокси MC: ' + (PROXY.host || 'НЕТ') + ':' + PROXY.port)
  step('YOLO API: ' + (YOLO.enabled ? 'ВКЛ → ' + YOLO.urls.join(' → ') + ' (поле "' + YOLO.field + '", таймаут ' + YOLO.timeoutMs + 'мс)' : 'ВЫКЛ (yolo.enabled=false)'))
  step('ЦИФРЫ: локальный распознаватель (встроен в main.js), база ' + LEARN_DIR)
  try {
    const st = DIG ? new DIG.GlyphStore(LEARN_DIR) : null
    const mdl = DIG ? DIG.MLP.load(LEARN_DIR) : null
    const q = DIG ? new DIG.LabelQueue(LEARN_DIR) : null
    step('  размечено глифов: ' + (st ? st.size : 0) + ' ' + JSON.stringify(st ? st.counts() : {}) +
      ' | MLP: ' + (mdl ? 'есть' : 'нет (node main.js --train)') +
      ' | в очереди на разметку: ' + (q ? q.size : 0))
    if (st && !st.size) step('  ⚠️ база пуста — цифры не распознаются. Соберите раунды, затем: node main.js --label')
    if (!mdl && DIG && DIG.MLP._stale) step('  ⚠️ model.json от старых признаков (fv=' + DIG.MLP._staleFv + ' ≠ ' + DIG.FEAT_VERSION + ') — проигнорирована, нужно --train заново')
    if (st && st.skippedVersion) step('  ⚠️ пропущено ' + st.skippedVersion + ' примеров старой версии признаков (несовместимы)')
  } catch (e) { step('  база цифр: ' + e.message) }
  step('capture: minTiles=' + CAP.minTiles + ' stableMs=' + CAP.stableMs + ' timeout=' + (CAP.timeoutMs / 1000) + 'с needPrompt=' + CAP.needPrompt)

  currentRunIp = await rotateIp()
  step('IP забега: ' + (currentRunIp || '?'))

  const ctx = { results: [], rotationsUsed: 0, consecutiveNetFails: 0, proxyFails: 0, proxyDead: false, aborted: false, tGlobal: Date.now() }

  if (TG.ready) {
    step('TELEGRAM: ВКЛ — бот-разметчик (предзагрузка ' + TG.prefetch + ' картинк' + (TG.prefetch > 1 ? 'и' : 'а') +
      ', chat_id=' + TG.chatId + ', автообучение ' + (TG.autoTrainEvery ? 'каждые ' + TG.autoTrainEvery + ' глифов' : 'выкл') + ')')
    const sp = parseSocksUrl(TG.socksUrl)
    step('  трафик Telegram: ' + (sp ? ('СОКС-прокси ' + sp.host + ':' + sp.port + ' (из ' + TG.socksKey + '), тип socks' + sp.type + (sp.username ? ', логин ' + sp.username : '') + ' → затем direct → затем мобильный прокси') :
      'напрямую (спец-прокси не задан: добавьте telegram.apiProxy) → затем мобильный прокси ' + (PROXY.host || 'НЕТ')) +
      (TG.preferSocks && sp ? '' : ''))
    const tgRes = await runTelegramSession(ctx)
    if (!tgRes || !tgRes.ok) { step('Telegram недоступен — переключаюсь в обычный режим (только сбор картинок)'); await runClassic(ctx) }
    else if (tgRes.st) { ctx.tg = tgRes.st }
  } else {
    if (!TG.enabled) step('TELEGRAM: отключён конфигом (telegram.enabled=false) — обычный режим')
    else if (!TG.token || /YOUR_/.test(TG.token)) step('TELEGRAM: не задан telegram.token — обычный режим (разметка через node main.js --label)')
    else if (!TG.chatId || /YOUR_/.test(TG.chatId)) step('TELEGRAM: не задан telegram.chatId — обычный режим (напиши боту /start и узнай свой id у @userinfobot)')
    else step('TELEGRAM: не готов — обычный режим')
    await runClassic(ctx)
  }

  printSummary(ctx)
}

function printSummary(ctx) {
  const okList = ctx.results.filter(x => x.ok)
  const L = ['=== СВОДКА ' + TARGET_ROUNDS + ' РАУНДОВ (v3.13.0) ===']
  L.push('успешных: ' + okList.length + '/' + TARGET_ROUNDS + ' | время: ' + Math.round((Date.now() - ctx.tGlobal) / 1000) + 'с')
  for (const x of ctx.results) {
    L.push('  #' + x.n + ': ' + (x.rec
      ? 'OK ' + x.rec.cols + '×' + x.rec.rows + ' tiles=' + x.rec.tilesCount + '/' + x.rec.tilesExpected +
        ' ori=' + x.rec.ori + ' rot=' + x.rec.rotRule + (x.rec.permUsed ? ' PERM' : '') +
        ' seam=' + x.rec.seamCost + ' YOLO="' + (x.rec.yolo ? x.rec.yolo.digits : '-') + '" ЛОКАЛЬНО="' + (x.rec.prediction || '') + '"' +
        (x.rec.needLabel ? ' [на разметку:' + x.rec.needLabel + ']' : '') +
        (x.rec.capFile ? ' [captchas/' + x.rec.capFile + ']' : '')
      : 'FAIL (' + (x.note || '') + ')'))
  }
  L.push('')
  L.push('Картинки: ' + CAP_ROOT)
  try {
    const q = DIG ? new DIG.LabelQueue(LEARN_DIR) : null
    const st = DIG ? new DIG.GlyphStore(LEARN_DIR) : null
    if (q && q.size) L.push('В очереди на разметку: ' + q.size + ' глифов → запустите: node main.js --label')
    if (st) L.push('База цифр: ' + st.size + ' глифов ' + JSON.stringify(st.counts()))
  } catch (e) {}
  step('готово.')
  flushReport(L.join('\n'))
  try {
    fs.writeFileSync(path.join(REC_ROOT, 'summary.json'), JSON.stringify({
      stamp: STAMP, version: '3.13.0', rounds: TARGET_ROUNDS, ok: okList.length,
      seconds: Math.round((Date.now() - tGlobal) / 1000),
      results: ctx.results.map(x => x.rec ? {
        round: x.n, ok: true, wall: x.rec.wall, grid: x.rec.cols + 'x' + x.rec.rows,
        tiles: x.rec.tilesCount + '/' + x.rec.tilesExpected, holesFilled: x.rec.holesFilled,
        orientation: x.rec.ori, rotationRule: x.rec.rotRule, permUsed: x.rec.permUsed,
        seamCost: x.rec.seamCost, score: x.rec.score, dot: x.rec.dot, dist: x.rec.dist,
        digits: x.rec.digits, digitsAll: x.rec.digitsAll, prediction: x.rec.prediction,
        yolo: x.rec.yolo ? { digits: x.rec.yolo.digits, host: x.rec.yolo.host, ms: x.rec.yolo.ms } : null, needLabel: x.rec.needLabel,
        candidates: (x.rec.candidates || []).map(c => ({ wall: c.wall, score: c.score })),
        file: x.rec.capFile, dir: x.rec.dir
      } : { round: x.n, ok: false, note: x.note })
    }, null, 2))
  } catch (e) { console.error('summary.json err:', e.message) }
  console.log('\n' + L.join('\n'))
  setTimeout(() => process.exit(0), 1500)
}

if (require.main === module) {
  main().catch(e => {
    console.error('\n!!! FATAL MAIN ERROR !!!\nMessage:', e.message, '\nStack:', e.stack)
    flushReport('FATAL: ' + (e.stack || e.message))
    setTimeout(() => process.exit(1), 1500)
  })
}

module.exports = {
  PALETTE, SHADE_MULT, BASE_COLORS, LUM, palDist, rotQ, encodePng, colorPng, bwPng,
  clusterValues, detectWalls, wallMinFrames, buildGrid, viewpointHAsc, orientationCandidates, rotationCandidates,
  dominantColor, composeImage, composeFromDisp, imageSeamCost, permSeamCost, pairSeam,
  optimizeRotations, propagateRotations, solveRotations, fillHolesDisplay,
  assembleWallSmart, captchaLikeness,
  extractFrameInfo, findMapIdDeep, getMapIdFromPacket, inkMaskWall, ocr,
  yawSpread, maxGridGap, wallDist, wallDot, GLYPH_OPTS, LEARN_DIR, DIG,
  selftest, makeSyntheticCaptcha, makeSyntheticDigits, makeWallSnapshot, saveRecord,
  runTrain, runLabel: runLabelTool, replayAll, replayDir, captureRound, runClassic, trainModel,
  YOLO, yoloRecognize, parseYoloAnswer, multipart, yoloReset,
  DIGITS_EXPECTED, finishSession, refreshPrediction,
  TG, tgApi, tgSendText, tgSendPhoto, runTelegramSession, runTgTest, parseSocksUrl, tgTransports, AsyncQueue, glyphStripPng,
  labelRoundWithDigits, dropQueueRound, httpsRequest, printSummary,
  // v3.12.0: офлайн-тюнинг сегментации и «золотая» разметка ответов
  answersFile, appendAnswer, loadAnswers, parseAnswersFromLog, importAnswersFromFile,
  listRoundDirs, loadRawImage, matchAnswersToDirs, cropsFromSegResult, looImageAccuracy,
  contactSheetPng, asciiRow, runAutotune, runDiag, stampOfDir,
  // v3.13.0: диагностика и отказоустойчивость прокси
  isIpV4, altHostOf, proxyHostCandidates, socks5Open, httpConnect, httpThrough, proxyTunnel,
  proxyConnect, proxyAlive, currentIp, socksHint, parseChangeIpResponse, ensureJsonParam,
  describeChangeIpUrl, runProxyCheck, mcStatusPing, PROXY, rotateIp
}
