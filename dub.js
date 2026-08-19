/*
 * AI-озвучка для Lampa (Fish Audio TTS, модель s2.1-pro-free). v2.0
 *
 * Отличия от v1 (lampa_dub_plugin.js в репозитории player2-lampa,
 * оставлен нетронутым как рабочий откат):
 *  - режим "по ролям": персонажи субтитров (.ass, поле Name) получают
 *    разные голоса, назначаемые по очереди первого появления на 5
 *    настраиваемых слотов; персонажи сверх 5 озвучиваются голосом
 *    "Персонаж 1" как голосом по умолчанию;
 *  - выбор голоса/режима доступен и в общих Настройках (Lampa.SettingsApi,
 *    component:'player'), и прямо в панели плеера (кнопка 🎙).
 *
 * Архитектура (общая с v1):
 *  - субтитры берём по ссылке из Lampa.Player.playdata().subtitles[i].url
 *    или напрямую опрашиваем TorrServer (см. findTorrserverSubtitleUrl) —
 *    публичного API для чтения активной дорожки у Lampa нет;
 *  - озвучка идёт "по мере просмотра": реплики на ближайшие ~15с вперёд
 *    досинтезируются в фоне, а не всё сразу при старте;
 *  - к Fish Audio плагин НЕ ходит напрямую: у /v1/tts нет CORS для
 *    браузерных запросов, а WebSocket-путь тоже недоступен из браузера
 *    (нельзя выставить Authorization-заголовок на хендшейке). Поэтому
 *    запросы идут через собственный Cloudflare Worker-прокси
 *    (fish-tts-proxy), который хранит ключ как секрет и сам добавляет
 *    Authorization + CORS-заголовки на ответ;
 *  - таймингам не подчиняемся жёстко: реплики идут последовательно без
 *    наложения (см. audioCursorMs), с накоплением рассинхрона до
 *    MAX_DRIFT_MS, после чего сбрасываемся обратно к таймингу субтитров
 *    (с возможным лёгким наложением);
 *  - воспроизведение — Web Audio API (AudioBufferSourceNode), не
 *    <audio>-теги: так можно точно спланировать старт каждой реплики
 *    и не бороться с play()/pause() гонками.
 *
 * ВАЖНО про type:'input'/'select' в Lampa.SettingsApi.addParam: обязательно
 * нужно поле param.values — без него Lampa падает при рендере строки
 * настроек (TypeError: Cannot read properties of undefined), это
 * подтверждённая особенность её внутреннего Params.select().
 */
(function () {
    'use strict';
    if (!window.Lampa) return;

    var LOG_PREFIX = '[ai-dub2]';

    // На одном Android TV обычный fetch() к внешним хостам зависал без
    // ошибок (см. комментарий в synthOne) — проблема оказалась именно в
    // fetch(), не в сети/прокси на устройстве, поэтому синтез специально
    // переведён на XMLHttpRequest, и внешний прокси снова используется
    // напрямую (никакого локального сервера на Mac не нужно).
    var TTS_PROXY_URL = 'https://fish-tts-proxy.player2vr.workers.dev/';

    var VOICES = {
        'c4ec5839e2044150aad40ac193a602f1': 'Володарский',
        '567d30e800cc4dd6a331411c7f970a47': 'Паша Техник',
        '4d72cce58e0b479e8aa135d8c1829edd': 'Патрик звезда',
        '5b99cb3218ee4f1a8090fbbca8c95241': 'Морти',
        'bc8eb8dcdc184763b0a769ee03275724': 'Жириновский',
        '205c5c4aadde43d2809636ad19773e6c': 'Стетхам',
        '493790cdb9c841f299e883478fb1b6a5': 'СССР',
        'e43f5f43e2df470a855dad3e0f2f369b': 'Морфеус',
        '558fa6f5859d4c55adbc830c076ba445': 'Тянка',
        '54076f8bfbc54979ad33764278e5e635': 'Микки Маус'
    };
    var VOICE_IDS = Object.keys(VOICES);
    var DEFAULT_REFERENCE_ID = 'c4ec5839e2044150aad40ac193a602f1'; // "Володарский"

    // Поправка prosody.volume (дБ, диапазон API -20..20) на голос — измерена
    // синтезом одной и той же тестовой фразы всеми голосами и сравнением
    // mean_volume (ffmpeg volumedetect), усреднено по 3 разным фразам для
    // устойчивости (см. Dub/voice_loudness_calibration.py). Без этого
    // некоторые голоса (например, Жириновский/Морти) звучат заметно громче
    // остальных, а Морфеус — заметно тише (там поправка почти на потолке
    // диапазона и всё равно не выравнивает громкость полностью).
    var VOICE_VOLUME_CORRECTION = {
        'c4ec5839e2044150aad40ac193a602f1': -0.2, // Володарский
        '567d30e800cc4dd6a331411c7f970a47': 0.2,  // Паша Техник
        '4d72cce58e0b479e8aa135d8c1829edd': 3.7,  // Патрик звезда
        '5b99cb3218ee4f1a8090fbbca8c95241': -5.9, // Морти
        'bc8eb8dcdc184763b0a769ee03275724': -6.6, // Жириновский
        '205c5c4aadde43d2809636ad19773e6c': 1.9,  // Стетхам
        '493790cdb9c841f299e883478fb1b6a5': 0.8,  // СССР
        'e43f5f43e2df470a855dad3e0f2f369b': 19.8, // Морфеус
        '558fa6f5859d4c55adbc830c076ba445': -2.8, // Тянка
        '54076f8bfbc54979ad33764278e5e635': -5.6  // Микки Маус
    };
    var CHARACTER_SLOTS = 5;
    var MODES = { single: 'Один голос', roles: 'По ролям' };

    function getReferenceId() {
        var id = Lampa.Storage.field('ai_dub_voice');
        return (id && VOICES[id]) ? id : DEFAULT_REFERENCE_ID;
    }

    function getMode() {
        var m = Lampa.Storage.field('ai_dub_mode');
        return (m === 'roles') ? 'roles' : 'single';
    }

    function getCharacterVoiceId(slotIndex) {
        // слот 0 ("Персонаж 1") — он же голос по умолчанию для персонажей,
        // которым не хватило слота (>5 разных персонажей в серии)
        var id = Lampa.Storage.field('ai_dub_char_voice_' + (slotIndex + 1));
        if (id && VOICES[id]) return id;
        return VOICE_IDS[slotIndex % VOICE_IDS.length]; // разумный дефолт "из коробки" — у слотов разные голоса
    }

    // ещё не прозвучавшие реплики пересинтезируем заново — иначе до конца
    // текущего сеанса звучал бы вперемешку старый (уже засинтезированный
    // и закэшированный) и новый голос/режим
    function invalidateUpcomingBuffers() {
        if (!current || !current.controller) return;
        var c = current.controller;
        for (var i = 0; i < c.state.length; i++) {
            if (c.state[i] === 'ready' || c.state[i] === 'loading') {
                c.state[i] = 'pending';
                c.buffers[i] = undefined;
            }
        }
    }

    function applyVoiceChange(value) {
        Lampa.Storage.set('ai_dub_voice', value);
        console.log(LOG_PREFIX, 'голос изменён на:', VOICES[value] || value);
        invalidateUpcomingBuffers();
    }

    function applyCharacterVoiceChange(slotIndex, value) {
        Lampa.Storage.set('ai_dub_char_voice_' + (slotIndex + 1), value);
        console.log(LOG_PREFIX, 'голос персонажа', slotIndex + 1, 'изменён на:', VOICES[value] || value);
        invalidateUpcomingBuffers();
    }

    function applyModeChange(value) {
        Lampa.Storage.set('ai_dub_mode', value);
        console.log(LOG_PREFIX, 'режим озвучки изменён на:', MODES[value] || value);
        invalidateUpcomingBuffers();
    }

    var LOOKAHEAD_MS = 15000;      // на сколько вперёд по времени видео досинтезируем
    var OVERLAP_TOLERANCE_MS = 300; // сколько наложения на следующую реплику терпим
    var MAX_SPEED = 1.7;           // потолок ускорения речи; если не укладываемся даже на этом потолке — просто ускоряем до потолка и оставляем небольшое наложение, а не кашу из слов
    var MAX_DRIFT_MS = 2500;       // насколько можно отстать от тайминга субтитров, играя реплики подряд без наложения, прежде чем смириться с наложением и вернуться к таймингу
    var DUCK_FACTOR = 0.15;        // во сколько раз приглушать оригинал ОТНОСИТЕЛЬНО текущей громкости пользователя
    var DUCK_IN_RAMP_MS = 120;     // приглушение перед репликой — резче
    var DUCK_OUT_RAMP_MS = 300;    // восстановление после реплики — чуть плавнее
    var DUCKING_CHECK_MS = 120;    // как часто проверять окна приглушения (чаще, чем общий tick — иначе короткие/наложенные реплики проваливаются между замерами раз в секунду)
    var SUB_FETCH_TIMEOUT_MS = 120000; // сколько ждать субтитры от TorrServer на холодном торренте
    var SEEK_SETTLE_MS = 1500;     // сколько ждать после перемотки, пока currentTime не перестанет скакать
    var TTS_FETCH_TIMEOUT_MS = 20000; // сколько ждать ответа от TTS-прокси, прежде чем считать запрос зависшим

    // Плавно меняет громкость САМОГО <video> (не через Lampa.PlayerVideo.volume() —
    // та ещё и сохраняет значение как пользовательскую настройку громкости в
    // Storage, а наше приглушение на время реплики — временное и не должно
    // перезаписывать реальную громкость, которую выставил себе пользователь).
    var volumeRampFrame = null;
    function rampVolume(video, targetVol, durationMs) {
        if (!video) return;
        if (volumeRampFrame) cancelAnimationFrame(volumeRampFrame);
        // video.volume у этой сборки Lampa иногда оказывается чуть больше 1
        // (видели IndexSizeError на промежуточных точках интерполяции) —
        // HTMLMediaElement.volume жёстко требует [0, 1], поэтому клэмпим
        // и стартовое значение, и каждый кадр анимации.
        var startVol = Math.max(0, Math.min(1, video.volume));
        var startTime = performance.now();
        function step(now) {
            var t = Math.min(1, (now - startTime) / durationMs);
            video.volume = Math.max(0, Math.min(1, startVol + (targetVol - startVol) * t));
            if (t < 1) volumeRampFrame = requestAnimationFrame(step);
            else volumeRampFrame = null;
        }
        volumeRampFrame = requestAnimationFrame(step);
    }

    // пока наша же анимация громкости в процессе, video.volume временно
    // не совпадает с "настоящей" пользовательской громкостью — если в
    // этот момент считать его за live-изменение от пользователя, громкость
    // с каждой репликой будет всё сильнее садиться (положительная обратная
    // связь: недоехавшее до цели значение принимается за новую цель)
    function isVolumeRamping() {
        return volumeRampFrame !== null;
    }

    // ---------------------------------------------------------------
    // Настройки в общем меню Lampa (Настройки → Плеер)
    // ---------------------------------------------------------------
    if (Lampa.SettingsApi) {
        Lampa.SettingsApi.addParam({
            component: 'player',
            param: { name: 'ai_dub_enabled', type: 'trigger', default: false },
            field: { name: 'AI-озвучка (Fish Audio)', description: 'Экспериментальный синхронный ИИ-дубляж поверх оригинальной дорожки' },
            onChange: function () { console.log(LOG_PREFIX, 'toggle ->', Lampa.Storage.field('ai_dub_enabled')); }
        });
        Lampa.SettingsApi.addParam({
            component: 'player',
            param: { name: 'ai_dub_mode', type: 'select', values: MODES, default: 'single' },
            field: { name: 'Режим озвучки', description: 'Один голос на всех или разные голоса по ролям' },
            onChange: function (value) { applyModeChange(value); }
        });
        Lampa.SettingsApi.addParam({
            component: 'player',
            param: { name: 'ai_dub_voice', type: 'select', values: VOICES, default: DEFAULT_REFERENCE_ID },
            field: { name: 'Голос озвучки (режим "Один голос")', description: 'Fish Audio voice' },
            onChange: function (value) { applyVoiceChange(value); }
        });
        for (var slotI = 0; slotI < CHARACTER_SLOTS; slotI++) {
            (function (slotIndex) {
                Lampa.SettingsApi.addParam({
                    component: 'player',
                    param: { name: 'ai_dub_char_voice_' + (slotIndex + 1), type: 'select', values: VOICES, default: VOICE_IDS[slotIndex % VOICE_IDS.length] },
                    field: { name: 'Голос — Персонаж ' + (slotIndex + 1), description: slotIndex === 0 ? 'Также голос по умолчанию для персонажей сверх 5 слотов' : '' },
                    onChange: function (value) { applyCharacterVoiceChange(slotIndex, value); }
                });
            })(slotI);
        }
    } else {
        console.warn(LOG_PREFIX, 'Lampa.SettingsApi недоступен — плагин загружен слишком рано или это не та версия Lampa');
    }

    function dubEnabled() {
        return Lampa.Storage.field('ai_dub_enabled');
    }

    // ---------------------------------------------------------------
    // Парсинг субтитров: srt / vtt / ass -> [{start_ms, end_ms, text, character}]
    // ---------------------------------------------------------------
    function timeToMs(h, m, s, frac) {
        // frac может быть 2 знака (.cc, ass) или 3 (,mmm / .mmm, srt/vtt)
        var ms = frac.length === 2 ? parseInt(frac, 10) * 10 : parseInt(frac, 10);
        return ((parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseInt(s, 10)) * 1000) + ms;
    }

    function parseSrtVtt(text) {
        var cues = [];
        var blocks = text.replace(/\r/g, '').split(/\n\n+/);
        var re = /(\d+):(\d{2}):(\d{2})[.,](\d{2,3})\s*-->\s*(\d+):(\d{2}):(\d{2})[.,](\d{2,3})/;
        blocks.forEach(function (block) {
            var lines = block.split('\n').filter(Boolean);
            for (var i = 0; i < lines.length; i++) {
                var m = re.exec(lines[i]);
                if (!m) continue;
                var start = timeToMs(m[1], m[2], m[3], m[4]);
                var end = timeToMs(m[5], m[6], m[7], m[8]);
                var textLines = lines.slice(i + 1);
                var cueText = textLines.join(' ')
                    .replace(/<[^>]+>/g, '')   // <font>, <b> и т.п.
                    .replace(/\{[^}]*\}/g, '') // ass-теги на всякий случай
                    .trim();
                // srt/vtt обычно не хранят имя персонажа отдельным полем —
                // character остаётся пустым, такие реплики в режиме "по
                // ролям" попадут в общий "неизвестный" бакет (см.
                // assignCharacterVoices) и получат голос "Персонаж 1"
                if (cueText) cues.push({ start_ms: start, end_ms: end, text: cueText, character: '' });
                break;
            }
        });
        return cues;
    }

    function parseAss(text) {
        var cues = [];
        var lines = text.replace(/\r/g, '').split('\n');
        var format = null;
        var section = '';
        var re = /(\d+):(\d{2}):(\d{2})\.(\d{2})/;
        lines.forEach(function (line) {
            var sectionMatch = /^\[([^\]]+)\]/.exec(line);
            if (sectionMatch) { section = sectionMatch[1].toLowerCase(); return; }
            // у .ass своя секция [V4+ Styles] тоже начинается с "Format:",
            // но с другим набором полей (22 шт. вместо 10 у [Events]) —
            // нужен именно формат из [Events], иначе индекс текста поедет
            // и все реплики будут молча отбрасываться как "неправильные"
            if (section === 'events' && /^Format:/i.test(line)) {
                format = line.replace(/^Format:\s*/i, '').split(',').map(function (s) { return s.trim(); });
                return;
            }
            if (!/^Dialogue:/i.test(line)) return;
            var rest = line.replace(/^Dialogue:\s*/i, '');
            var textIdx = format ? format.length - 1 : 9;
            // индекс поля "Name"/"Actor" (кто говорит) — ищем по названию
            // в Format, а не по фиксированной позиции: некоторые релизы
            // используют "Actor" вместо "Name", да и порядок полей не
            // всегда классический
            var nameIdx = format ? (format.indexOf('Name') !== -1 ? format.indexOf('Name') : format.indexOf('Actor')) : 4;
            var parts = rest.split(',');
            if (parts.length <= textIdx) return;
            var startStr = parts[1], endStr = parts[2];
            var rawText = parts.slice(textIdx).join(',');
            var sm = re.exec(startStr), em = re.exec(endStr);
            if (!sm || !em) return;
            var start = timeToMs(sm[1], sm[2], sm[3], sm[4]);
            var end = timeToMs(em[1], em[2], em[3], em[4]);
            var cueText = rawText
                .replace(/\{[^}]*\}/g, '')   // ass override-теги {\...}
                .replace(/\\N/g, ' ')
                .replace(/\\n/g, ' ')
                .trim();
            var character = (nameIdx >= 0 && parts[nameIdx]) ? parts[nameIdx].trim() : '';
            if (cueText) cues.push({ start_ms: start, end_ms: end, text: cueText, character: character });
        });
        return cues;
    }

    function parseSubtitles(url, text) {
        var lower = url.toLowerCase();
        var cues;
        if (lower.indexOf('.ass') !== -1 || /^\[script info\]/im.test(text)) {
            cues = parseAss(text);
        } else {
            cues = parseSrtVtt(text);
        }
        cues.sort(function (a, b) { return a.start_ms - b.start_ms; });
        return cues;
    }

    // Персонажи получают слоты 0..4 в порядке ПЕРВОГО появления в субтитрах.
    // Всё, что не попало в первые 5 разных имён (или вообще без имени,
    // как в большинстве .srt/.vtt) — озвучивается голосом слота 0
    // ("Персонаж 1"), он же голос по умолчанию.
    function assignCharacterSlots(cues) {
        var order = [];
        cues.forEach(function (cue) {
            var name = cue.character || '';
            if (name && order.indexOf(name) === -1 && order.length < CHARACTER_SLOTS) order.push(name);
        });
        cues.forEach(function (cue) {
            var name = cue.character || '';
            var idx = order.indexOf(name);
            cue.characterSlot = idx === -1 ? 0 : idx;
        });
        if (order.length) console.log(LOG_PREFIX, 'персонажи по порядку появления (слоты 1-' + CHARACTER_SLOTS + '):', order);
    }

    function referenceIdForCue(cue) {
        return getMode() === 'roles' ? getCharacterVoiceId(cue.characterSlot || 0) : getReferenceId();
    }

    // ---------------------------------------------------------------
    // Fish Audio TTS: одна реплика за один POST-запрос
    // ---------------------------------------------------------------
    function synthOne(text, referenceId, speed) {
        var volumeCorrection = VOICE_VOLUME_CORRECTION[referenceId] || 0;
        // На одном Android TV POST-запросы (и через fetch, и через XHR, с
        // телом любой формы — JSON, с preflight и без) зависали к ЛЮБОМУ
        // внешнему хосту без единой ошибки, а обычный внешний GET отвечал
        // быстро и нормально (проверено отдельным диагностическим тестом
        // прямо на нашем же воркере: GET -> 405 за 491мс). Поэтому синтез
        // идёт через GET с параметрами в query-строке — воркер сам,
        // получив их, собирает обычный POST-запрос к Fish Audio уже НЕ из
        // этого WebView, так что там это ограничение не действует.
        var params = 'text=' + encodeURIComponent(text) + '&reference_id=' + encodeURIComponent(referenceId);
        if (speed && speed !== 1) params += '&speed=' + encodeURIComponent(Math.max(0.5, Math.min(2.0, speed)));
        if (volumeCorrection) params += '&volume=' + encodeURIComponent(Math.max(-20, Math.min(20, volumeCorrection)));

        return new Promise(function (resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', TTS_PROXY_URL + '?' + params, true);
            xhr.responseType = 'arraybuffer';
            xhr.timeout = TTS_FETCH_TIMEOUT_MS;
            xhr.onload = function () {
                if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response);
                else reject(new Error('TTS proxy HTTP ' + xhr.status));
            };
            xhr.onerror = function () { reject(new Error('TTS proxy XHR network error')); };
            xhr.ontimeout = function () {
                console.warn(LOG_PREFIX, 'запрос к TTS-прокси завис (' + (TTS_FETCH_TIMEOUT_MS / 1000) + 'с без ответа), обрываю:', JSON.stringify(text));
                reject(new Error('TTS proxy XHR timeout'));
            };
            xhr.send();
        });
    }

    // ---------------------------------------------------------------
    // Контроллер дубляжа для одного сеанса воспроизведения
    // ---------------------------------------------------------------
    function DubController(video, cues) {
        this.video = video;
        this.cues = cues;
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.state = cues.map(function () { return 'pending'; }); // pending|loading|ready|failed|played
        this.buffers = new Array(cues.length);
        this.sources = [];
        this.destroyed = false;
        // видео и пауза/перемотка отслеживаются ОПРОСОМ в tick(), а не через
        // addEventListener на конкретном узле — Lampa, судя по всему,
        // пересоздаёт <video> в процессе запуска воспроизведения, и любой
        // слушатель, повешенный на старый узел, тихо перестаёт стрелять
        // (currentTime у сохранённой ссылки застревал на 0, хотя в DOM
        // реальный элемент уже играл и currentTime у него рос).
        this.lastKnownMs = video.currentTime * 1000;
        this.ctxSuspended = video.paused;
        if (video.paused) this.ctx.suspend();
        this.activeWindows = []; // [{start_ms, end_ms}] — когда реально звучит синтезированная реплика
        this.ducked = false;
        this.seekSettleUntil = 0;
        this.audioCursorMs = -Infinity; // до какого момента (по видео) уже "занято" предыдущей репликой — см. scheduleReady

        // громкость дубляжа синхронна с той, что пользователь выставил
        // штатным регулятором Lampa (она же и хранит её между сессиями) —
        // отдельного UI/настройки для громкости озвучки не делаем, просто
        // масштабируем реплики относительно текущей громкости видео.
        this.masterVolume = Math.max(0, Math.min(1, video.volume));
        this.gainNode = this.ctx.createGain();
        this.gainNode.connect(this.ctx.destination);
        this.gainNode.gain.value = this.masterVolume;
    }

    DubController.prototype.budgetMs = function (i) {
        var cue = this.cues[i];
        var next = this.cues[i + 1];
        return next ? (next.start_ms - cue.start_ms) : (cue.end_ms - cue.start_ms + 1000);
    };

    DubController.prototype.ensureSynthesized = function (i) {
        var self = this;
        if (this.state[i] !== 'pending') return;
        this.state[i] = 'loading';
        var cue = this.cues[i];
        var referenceId = referenceIdForCue(cue);
        console.log(LOG_PREFIX, 'синтезирую реплику', i, JSON.stringify(cue.text), 'голос:', VOICES[referenceId] || referenceId, cue.character ? '(' + cue.character + ')' : '');

        synthOne(cue.text, referenceId, 1).then(function (buf) {
            console.log(LOG_PREFIX, 'реплика', i, 'получена от Fish Audio,', buf.byteLength, 'байт');
            return self.ctx.decodeAudioData(buf.slice(0)).then(function (audioBuf) {
                var allowedMs = self.budgetMs(i) + OVERLAP_TOLERANCE_MS;
                var synthMs = audioBuf.duration * 1000;
                if (synthMs <= allowedMs) {
                    self.buffers[i] = audioBuf;
                    self.state[i] = 'ready';
                    console.log(LOG_PREFIX, 'реплика', i, 'готова, ' + synthMs.toFixed(0) + 'мс, без коррекции скорости');
                    return;
                }
                // не уложились даже с запасом на наложение — досинтезируем с ускорением,
                // но не быстрее MAX_SPEED — после этого разобрать речь почти нереально,
                // лучше оставить небольшое наложение на следующую реплику
                var speed = Math.min(MAX_SPEED, synthMs / allowedMs);
                console.log(LOG_PREFIX, 'реплика', i, 'не укладывается (' + synthMs.toFixed(0) + 'мс из ' + allowedMs.toFixed(0) + 'мс), ускоряю в', speed.toFixed(2), 'раза' + (speed >= MAX_SPEED ? ' (потолок, останется небольшое наложение)' : ''));
                return synthOne(cue.text, referenceId, speed).then(function (buf2) {
                    return self.ctx.decodeAudioData(buf2.slice(0));
                }).then(function (audioBuf2) {
                    self.buffers[i] = audioBuf2;
                    self.state[i] = 'ready';
                    console.log(LOG_PREFIX, 'реплика', i, 'готова после ускорения');
                });
            });
        }).catch(function (err) {
            console.warn(LOG_PREFIX, 'ошибка синтеза реплики', i, cue.text, err);
            self.state[i] = 'failed';
        });
    };

    DubController.prototype.scheduleReady = function () {
        var self = this;
        var nowVideoMs = this.video.currentTime * 1000;
        this.cues.forEach(function (cue, i) {
            if (self.state[i] !== 'ready') return;
            if (cue.start_ms < nowVideoMs - 500) { self.state[i] = 'played'; return; } // прозевали (перемотка вперёд)
            var delaySec = (cue.start_ms - nowVideoMs) / 1000;
            if (delaySec > (LOOKAHEAD_MS / 1000) + 1) return; // ещё рано планировать
            self.state[i] = 'played';

            var durationMs = self.buffers[i].duration * 1000;
            // Если предыдущая реплика ещё звучит к моменту старта этой —
            // вместо наложения голосов сдвигаем старт этой реплики на
            // момент, когда предыдущая реально закончится (последовательно,
            // без наложения), но не больше чем на MAX_DRIFT_MS относительно
            // её собственного места по субтитрам — иначе рассинхрон с
            // видео будет только расти. Если сдвиг превысил бы потолок,
            // возвращаемся к обычному наложению и сбрасываем "курсор",
            // чтобы дальше снова идти по факту субтитров.
            var actualStartMs = cue.start_ms;
            if (self.audioCursorMs > cue.start_ms) {
                var drift = self.audioCursorMs - cue.start_ms;
                if (drift <= MAX_DRIFT_MS) {
                    actualStartMs = self.audioCursorMs;
                } // иначе оставляем actualStartMs = cue.start_ms — пусть лучше наложится, чем разъедется совсем
            }
            self.audioCursorMs = actualStartMs + durationMs;

            var startDelaySec = (actualStartMs - nowVideoMs) / 1000;
            var src = self.ctx.createBufferSource();
            src.buffer = self.buffers[i];
            src.connect(self.gainNode);
            var startAt = self.ctx.currentTime + Math.max(0, startDelaySec);
            src.start(startAt);
            self.sources.push(src);
            // окно, в которое реально звучит эта реплика — по нему приглушаем
            // оригинал, а не постоянно на всё время работы озвучки
            self.activeWindows.push({ start_ms: actualStartMs, end_ms: actualStartMs + durationMs });
        });
    };

    DubController.prototype.updateDucking = function () {
        if (this.destroyed || !this.video) return;
        // читаем currentTime заново сами — этот метод дёргается отдельным
        // частым таймером (DUCKING_CHECK_MS), не общим 1-секундным tick():
        // короткие/наложенные реплики могут целиком провалиться между
        // замерами раз в секунду, из-за чего звук успевал "прорваться"
        // на полную громкость посреди фразы.
        var nowVideoMs = this.video.currentTime * 1000;
        this.activeWindows = this.activeWindows.filter(function (w) { return w.end_ms >= nowVideoMs - 200; });
        var shouldDuck = this.activeWindows.some(function (w) { return nowVideoMs >= w.start_ms && nowVideoMs <= w.end_ms; });

        // Источник "какая громкость нужна пользователю" — Lampa.Storage
        // ('player_volume'), КУДА МЫ САМИ НИКОГДА НЕ ПИШЕМ, а не сам
        // video.volume: тот video.volume мы же и дёргаем при
        // приглушении/восстановлении, и любая попытка читать его как
        // "живой пользовательский ввод" рано или поздно ловит момент,
        // когда там ещё/уже наше собственное временное значение —
        // это и давало положительную обратную связь, из-за которой
        // громкость с каждой репликой садилась всё сильнее. Storage же
        // меняется ТОЛЬКО когда пользователь сам трогает штатный регулятор.
        var storedVol = Lampa.Storage.get('player_volume', null);
        if (storedVol !== null) {
            storedVol = Math.max(0, Math.min(1, parseFloat(storedVol)));
            if (!isNaN(storedVol) && Math.abs(storedVol - this.masterVolume) > 0.005) {
                this.masterVolume = storedVol;
                this.gainNode.gain.value = this.masterVolume;
                if (!shouldDuck) rampVolume(this.video, this.masterVolume, 80);
            }
        }

        if (shouldDuck === this.ducked) return;
        this.ducked = shouldDuck;
        if (shouldDuck) {
            rampVolume(this.video, this.masterVolume * DUCK_FACTOR, DUCK_IN_RAMP_MS);
            this.gainNode.gain.value = this.masterVolume; // дубляж сам звучит на полной пользовательской громкости
        } else {
            rampVolume(this.video, this.masterVolume, DUCK_OUT_RAMP_MS);
        }
    };

    DubController.prototype.cancelScheduled = function () {
        this.sources.forEach(function (src) { try { src.stop(); } catch (e) {} });
        this.sources = [];
        for (var i = 0; i < this.state.length; i++) {
            if (this.state[i] === 'played') this.state[i] = this.buffers[i] ? 'ready' : 'pending';
        }
        this.activeWindows = [];
        this.audioCursorMs = -Infinity; // после перемотки старый "курсор" бессмысленен
        if (this.ducked) {
            this.ducked = false;
            rampVolume(this.video, this.masterVolume, DUCK_OUT_RAMP_MS);
        }
    };

    DubController.prototype.tick = function () {
        if (this.destroyed) return;

        // всегда спрашиваем актуальный <video> заново — см. комментарий
        // в конструкторе про пересоздание элемента самой Lampa
        var liveVideo = Lampa.PlayerVideo.video();
        if (liveVideo) this.video = liveVideo;
        var video = this.video;
        var nowVideoMs = video.currentTime * 1000;

        var advancingMs = nowVideoMs - this.lastKnownMs;
        var isSeek = Math.abs(advancingMs - 1000) > 2500; // большой скачок — перемотка
        // буферизация: видео.paused остаётся false, когда браузер просто
        // ждёт данных (readyState/"waiting") — currentTime при этом почти
        // не двигается. Раньше мы следили только за paused, и AudioContext
        // продолжал идти своим ходом, играя реплики по расписанию, пока
        // зависшее видео стояло на месте ("озвучка на несколько фраз вперёд").
        var isStalled = !video.paused && !isSeek && advancingMs < 200;
        var shouldSuspend = video.paused || isStalled;

        if (shouldSuspend !== this.ctxSuspended) {
            this.ctxSuspended = shouldSuspend;
            if (shouldSuspend) {
                this.ctx.suspend();
                console.log(LOG_PREFIX, video.paused ? 'видео на паузе — глушу AudioContext' : 'видео зависло на буферизации — глушу AudioContext');
            } else {
                this.ctx.resume();
                console.log(LOG_PREFIX, 'видео продолжилось — возобновляю AudioContext');
            }
        }

        // перемотка — сбрасываем всё запланированное, т.к. тайминги больше не актуальны.
        // Дальше даём позиции "устояться" (SEEK_SETTLE_MS): после перемотки
        // видео/TorrServer может ещё пару тиков дёргаться (буферизация на
        // новом месте), и если планировать реплики сразу по нестабильному
        // currentTime — получается "волна" из нескольких реплик почти
        // одновременно, невпопад. Планирование заново включаем только
        // когда currentTime перестаёт скакать.
        if (isSeek) {
            console.log(LOG_PREFIX, 'похоже на перемотку (' + (this.lastKnownMs / 1000).toFixed(1) + 'с -> ' + (nowVideoMs / 1000).toFixed(1) + 'с), сбрасываю запланированное и жду стабилизации');
            this.cancelScheduled();
            this.seekSettleUntil = Date.now() + SEEK_SETTLE_MS;
        }
        this.lastKnownMs = nowVideoMs;

        if (this.seekSettleUntil && Date.now() < this.seekSettleUntil) {
            return; // ждём, пока позиция устаканится, ничего не планируем в этот тик
        }
        this.seekSettleUntil = 0;

        var self = this;
        var inWindow = 0;
        this.cues.forEach(function (cue, i) {
            if (cue.start_ms - nowVideoMs <= LOOKAHEAD_MS && cue.start_ms >= nowVideoMs - 2000) {
                inWindow++;
                self.ensureSynthesized(i);
            }
        });
        this._tickCount = (this._tickCount || 0) + 1;
        if (this._tickCount % 5 === 1) {
            console.log(LOG_PREFIX, 'tick, видео на', (nowVideoMs / 1000).toFixed(1) + 'с, реплик в окне поиска:', inWindow);
        }
        this.scheduleReady();
        // приглушение обновляется своим отдельным частым таймером (см. startDub), не тут
    };

    DubController.prototype.destroy = function () {
        this.destroyed = true;
        this.sources.forEach(function (src) { try { src.stop(); } catch (e) {} });
        this.sources = [];
        try { this.ctx.close(); } catch (e) {}
    };

    // ---------------------------------------------------------------
    // Подключение к плееру
    // ---------------------------------------------------------------
    var current = null; // { controller, timer }
    // Lampa шлёт 'start' дважды подряд (предзагрузка + реальный запуск).
    // Каждый вызов startDub() получает свой номер поколения; если пока
    // старый fetch() субтитров ещё летит (например, завис на холодном
    // старте торрента) стартовал более новый запуск — старый, долетев,
    // не должен затирать уже рабочий current своим устаревшим состоянием.
    var generation = 0;

    function stopCurrent() {
        generation++; // любой ещё летящий fetch() субтитров из прошлого запуска теперь считается устаревшим
        if (!current) return;
        if (current.timer) clearInterval(current.timer);
        if (current.duckTimer) clearInterval(current.duckTimer);
        // возвращаем громкость видео на ту, что реально выставил пользователь
        // (а не жёстко на 1) — если сейчас приглушено по нашей вине
        if (current.controller && current.controller.ducked && current.controller.video) {
            try { current.controller.video.volume = current.controller.masterVolume; } catch (e) {}
        }
        if (current.controller) current.controller.destroy();
        current = null;
    }

    function startDub(subtitleUrl) {
        stopCurrent();
        var video = Lampa.PlayerVideo.video();
        if (!video || !subtitleUrl) return;

        var myGeneration = generation;
        var startedAt = Date.now();

        // холодный торрент: TorrServer может отдавать субтитровый файл
        // отдельно от видео (свой приоритет пиров/кусков) и молчать до
        // ~90с при первом обращении — печатаем "жду ещё" вместо тишины,
        // чтобы не выглядело зависшим, и прекращаем ждать через SUB_FETCH_TIMEOUT_MS.
        var heartbeat = setInterval(function () {
            if (myGeneration !== generation) { clearInterval(heartbeat); return; }
            console.log(LOG_PREFIX, 'всё ещё жду субтитры от TorrServer (' + ((Date.now() - startedAt) / 1000).toFixed(0) + 'с) — это нормально для только что открытого торрента, ждём пиров');
        }, 10000);
        var abortController = new AbortController();
        var timeoutTimer = setTimeout(function () {
            console.warn(LOG_PREFIX, 'TorrServer не отдал субтитры за ' + (SUB_FETCH_TIMEOUT_MS / 1000) + 'с, обрываю запрос и сдаюсь на этот запуск');
            abortController.abort();
        }, SUB_FETCH_TIMEOUT_MS);

        fetch(subtitleUrl, { signal: abortController.signal }).then(function (r) {
            console.log(LOG_PREFIX, 'ответ на запрос субтитров:', r.status, r.ok, r.headers.get('content-type'), r.headers.get('content-length'));
            return r.text();
        }).then(function (text) {
            clearInterval(heartbeat);
            clearTimeout(timeoutTimer);
            if (myGeneration !== generation) {
                console.log(LOG_PREFIX, 'этот запуск (#' + myGeneration + ') устарел, за это время стартовал #' + generation + ' — игнорирую результат');
                return;
            }
            console.log(LOG_PREFIX, 'текст субтитров, длина:', text.length, 'превью:', JSON.stringify(text.slice(0, 200)));
            var cues = parseSubtitles(subtitleUrl, text);
            console.log(LOG_PREFIX, 'распознано реплик:', cues.length);
            if (!cues.length) {
                console.warn(LOG_PREFIX, 'субтитры пустые или не распознаны:', subtitleUrl);
                return;
            }
            assignCharacterSlots(cues);
            // ещё раз проверяем поколение — пока парсили, мог подоспеть новый старт
            if (myGeneration !== generation) return;
            // pause/play/перемотку контроллер отслеживает сам опросом в
            // tick() (см. DubController) — DOM-события тут не нужны и
            // ненадёжны, раз Lampa пересоздаёт <video> в процессе запуска.
            var liveVideo = Lampa.PlayerVideo.video() || video;
            var controller = new DubController(liveVideo, cues);
            console.log(LOG_PREFIX, 'AudioContext создан, состояние:', controller.ctx.state, '(если "suspended" не сменится на "running" сам по себе — должен помочь любой тап/клик, см. разблокировку по жесту)');
            var timer = setInterval(function () { controller.tick(); }, 1000);
            // приглушение — отдельным частым таймером, а не общим 1-секундным
            // tick(): короткие/наложенные реплики иначе проваливались между
            // редкими замерами, и звук успевал прорваться на полную громкость
            var duckTimer = setInterval(function () { controller.updateDucking(); }, DUCKING_CHECK_MS);
            current = { controller: controller, timer: timer, duckTimer: duckTimer };
            controller.tick();
            controller.updateDucking();
        }).catch(function (err) {
            clearInterval(heartbeat);
            clearTimeout(timeoutTimer);
            if (err && err.name === 'AbortError') {
                console.warn(LOG_PREFIX, 'не дождались субтитров от TorrServer за ' + (SUB_FETCH_TIMEOUT_MS / 1000) + 'с — торрент слишком холодный или пиров нет');
            } else {
                console.warn(LOG_PREFIX, 'не удалось загрузить субтитры', err);
            }
        });
    }

    // -----------------------------------------------------------------
    // Резервный путь: для торрент-источников (TorrServer) Lampa часто НЕ
    // заполняет data.subtitles — субтитровый файл в такой раздаче просто
    // ещё один файл торрента (например, .ass рядом с .mkv), а не отдельно
    // объявленная "дорожка". Спрашиваем список файлов у самого TorrServer
    // (тот же хост, что отдаёт видео) и ищем .srt/.ass/.vtt в той же папке.
    // -----------------------------------------------------------------
    var SUB_EXT_RE = /\.(ass|ssa|srt|vtt)$/i;

    function findTorrserverSubtitleUrl(videoUrl) {
        var m = /^(https?:\/\/[^/]+)\/stream\/[^?]*\?link=([0-9a-f]+)/i.exec(videoUrl || '');
        if (!m) return Promise.resolve(null);
        var origin = m[1], hash = m[2];

        return fetch(origin + '/torrents', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'get', hash: hash })
        }).then(function (r) { return r.json(); }).then(function (torrent) {
            var files = (torrent && torrent.file_stats) || [];
            var videoPath = decodeURIComponent(videoUrl.split('/stream/')[1].split('?')[0]);
            var videoDir = videoPath.substring(0, videoPath.lastIndexOf('/'));
            var videoStem = videoPath.split('/').pop().replace(/\.[^.]+$/, '');
            var subFiles = files.filter(function (f) { return SUB_EXT_RE.test(f.path); });

            // Раздача может быть батчем на весь сезон под одним хэшем —
            // берём ТОЛЬКО файл, чьё имя без расширения совпадает с именем
            // видео. Если точного совпадения нет — лучше промолчать, чем
            // найти "любой сабовый файл в раздаче" и озвучить не ту серию.
            var candidate = subFiles.find(function (f) {
                var stem = f.path.split('/').pop().replace(/\.[^.]+$/, '');
                return stem === videoStem;
            });
            if (!candidate) {
                // запасной вариант — тот же каталог, что и видео (для раздач
                // без строгого совпадения имён файлов серии/сабов)
                candidate = subFiles.find(function (f) {
                    return f.path.substring(0, f.path.lastIndexOf('/')) === videoDir;
                });
            }
            if (!candidate) return null;
            var basename = candidate.path.split('/').pop();
            return origin + '/stream/' + encodeURIComponent(basename) + '?link=' + hash + '&index=' + candidate.id + '&play';
        }).catch(function (err) {
            console.warn(LOG_PREFIX, 'не удалось опросить TorrServer на предмет субтитров', err);
            return null;
        });
    }

    var lastHandledVideoUrl = '';

    function handleVideoSource(videoUrl, dataSubtitles) {
        lastHandledVideoUrl = videoUrl;

        // Для TorrServer-источников всегда переспрашиваем АКТУАЛЬНЫЙ индекс
        // файла субтитров напрямую у TorrServer, а не берём снэпшот из
        // data.subtitles: на самом первом открытии свежедобавленного
        // торрента метаданные (список файлов/индексы) могли ещё не до
        // конца устояться в момент события 'start', и Lampa могла отдать
        // ссылку со "старым"/неверным index= — TorrServer на такой запрос
        // просто никогда не ответит (не 404, а вечное ожидание).
        if (/\/stream\/[^?]*\?link=[0-9a-f]+/i.test(videoUrl)) {
            console.log(LOG_PREFIX, 'источник — TorrServer, спрашиваю свежий индекс субтитров напрямую:', videoUrl);
            findTorrserverSubtitleUrl(videoUrl).then(function (url) {
                if (url) { console.log(LOG_PREFIX, 'нашёл субтитры через TorrServer:', url); startDub(url); return; }
                console.warn(LOG_PREFIX, 'в этой раздаче не нашлось файла субтитров (.ass/.srt/.vtt) через TorrServer, пробую data.subtitles как запасной вариант');
                var subs = dataSubtitles || [];
                if (subs.length) startDub(subs[0].url);
                else console.warn(LOG_PREFIX, 'субтитров нигде не нашлось');
            });
            return;
        }

        var subs = dataSubtitles || [];
        if (!subs.length) {
            var pd = Lampa.Player.playdata && Lampa.Player.playdata();
            subs = (pd && pd.subtitles) || [];
        }
        if (subs.length) {
            console.log(LOG_PREFIX, 'запускаю озвучку по дорожке из data.subtitles:', subs[0].url);
            startDub(subs[0].url);
        } else {
            console.warn(LOG_PREFIX, 'у этого видео нет субтитровой дорожки');
        }
    }

    // Плеер сейчас реально открыт? Сторож ниже не должен ничего делать,
    // если видео уже закрыто — Lampa.PlayerVideo.video() может продолжать
    // отдавать старый/отсоединённый <video>-узел даже после закрытия
    // плеера, и без этого флага сторож принимал это за "видео сменилось"
    // и пытался снова запустить озвучку на уже закрытом плеере.
    var playerActive = false;

    // -----------------------------------------------------------------
    // Кнопка в панели плеера (не в общих Настройках). Внедрять пункт в
    // штатное меню Subtitles/Quality/Settings нельзя — там приватный
    // массив без точки расширения для плагинов. Рабочий паттерн (как у
    // реального плагина Shots): своя кнопка в панели, открывающая свой
    // Lampa.Select.show(...) попап — тут двухуровневый: режим -> голос(а).
    // -----------------------------------------------------------------
    function openVoiceListFor(onPicked, activeId) {
        var items = VOICE_IDS.map(function (id) {
            return { title: VOICES[id], id: id, selected: id === activeId };
        });
        Lampa.Select.show({
            title: 'Выбор голоса',
            items: items,
            onSelect: function (item) { onPicked(item.id); },
            onBack: function () { openRootMenu(); }
        });
    }

    function openCharacterMenu() {
        var items = [];
        for (var i = 0; i < CHARACTER_SLOTS; i++) {
            items.push({ title: 'Персонаж ' + (i + 1) + (i === 0 ? ' (по умолчанию)' : '') + ': ' + (VOICES[getCharacterVoiceId(i)] || ''), slot: i });
        }
        Lampa.Select.show({
            title: 'Голоса персонажей',
            items: items,
            onSelect: function (item) {
                openVoiceListFor(function (voiceId) { applyCharacterVoiceChange(item.slot, voiceId); }, getCharacterVoiceId(item.slot));
            },
            onBack: function () { openRootMenu(); }
        });
    }

    function openRootMenu() {
        var mode = getMode();
        var items = [
            { title: 'Режим: ' + (MODES[mode] || mode), mode_toggle: true },
        ];
        if (mode === 'roles') {
            items.push({ title: 'Голоса персонажей…', open_characters: true });
        } else {
            items.push({ title: 'Голос: ' + (VOICES[getReferenceId()] || ''), open_voice: true });
        }
        Lampa.Select.show({
            title: 'AI-озвучка',
            items: items,
            onSelect: function (item) {
                if (item.mode_toggle) { applyModeChange(mode === 'roles' ? 'single' : 'roles'); openRootMenu(); return; }
                if (item.open_characters) { openCharacterMenu(); return; }
                if (item.open_voice) { openVoiceListFor(applyVoiceChange, getReferenceId()); return; }
            },
            onBack: function () {
                // Select сам закрывается, но фокус пульта/клавиатуры после
                // этого нужно явно вернуть панели плеера — иначе он
                // повисает в никуда, и управление плеером "замерзает"
                // (баг, о котором сообщили: после Select.show() и нажатия
                // "назад" ничего больше не реагирует на пульт).
                try { Lampa.Controller.toggle('player_panel'); } catch (e) {}
            }
        });
    }

    function ensureVoiceButton() {
        if (!Lampa.PlayerPanel || !Lampa.PlayerPanel.render) return;
        var panel = Lampa.PlayerPanel.render();
        if (!panel || !panel.length || panel.find('.ai-dub-voice-btn').length) return;

        var btn = document.createElement('div');
        btn.className = 'button selector ai-dub-voice-btn';
        btn.setAttribute('data-controller', 'player_panel');
        btn.style.cssText = 'display:flex;align-items:center;justify-content:center;font-size:0.85em;';
        btn.textContent = '🎙';
        btn.addEventListener('click', openRootMenu);
        if (window.$) $(btn).on('hover:enter', openRootMenu); // фокус-навигация пультом/клавиатурой

        var settingsBtn = panel.find('.player-panel__settings');
        if (settingsBtn.length) settingsBtn.after(btn);
        else panel.append(btn);
    }

    Lampa.Player.listener.follow('start', function (data) {
        console.log(LOG_PREFIX, 'player start, enabled =', dubEnabled(), 'data =', data);
        playerActive = true;
        // панель плеера может отрисоваться чуть позже самого события 'start' —
        // пробуем добавить кнопку несколько раз с небольшой паузой
        [300, 800, 1500, 3000].forEach(function (ms) { setTimeout(ensureVoiceButton, ms); });
        if (!dubEnabled()) { console.log(LOG_PREFIX, 'выключено в настройках — выходим'); return; }
        var videoUrl = (data && data.url) || (Lampa.PlayerVideo.video() && Lampa.PlayerVideo.video().currentSrc) || '';
        handleVideoSource(videoUrl, data && data.subtitles);
    });

    Lampa.Player.listener.follow('destroy', function () {
        playerActive = false;
        stopCurrent();
        // lastHandledVideoUrl НЕ сбрасываем: если после закрытия плеер
        // пришлёт ещё какое-то событие/сторож на мгновение решит, что
        // playerActive снова true (например, спурионый 'start' при
        // переходе на экран деталей), src того же самого уже закрытого
        // видео совпадёт с последним обработанным и не даст ложно
        // "обнаружить смену видео" на пустом месте.
    });

    // Сторож автоперехода на следующую серию/эпизод: плеер при этом не
    // всегда шлёт 'start' заново (сам <video> не пересоздаётся, просто
    // подгружает новый src) — без этого плагин продолжал бы озвучивать
    // по субтитрам ПРЕДЫДУЩЕЙ серии поверх уже другого видео. Опрашиваем
    // src живого видео независимо от событий плеера и сравниваем с тем,
    // под что сейчас реально настроена озвучка.
    setInterval(function () {
        if (!playerActive || !dubEnabled()) return;
        var video = Lampa.PlayerVideo.video();
        var src = video && (video.currentSrc || video.src);
        if (!src || src === lastHandledVideoUrl) return;
        console.log(LOG_PREFIX, 'обнаружил смену видео без события player-start (похоже на автопереход к следующей серии):', src);
        handleVideoSource(src, null);
    }, 2000);

    // -----------------------------------------------------------------
    // Разблокировка AudioContext в WebView (Android-приложение Lampa).
    // В отличие от полноценного Chrome, многие WebView-движки требуют
    // ПРЯМОГО пользовательского жеста (тап/клик/нажатие пульта), чтобы
    // AudioContext реально перешёл в running — иначе он тихо остаётся
    // suspended, и звук физически не идёт, хотя вся остальная логика
    // (синтез, планирование через ctx.currentTime) отрабатывает как ни
    // в чём не бывало и в логах всё выглядит нормально. Обычный resume()
    // из таймера/промиса (как в updateDucking/tick) в WebView может не
    // сработать — нужен resume() именно ИЗНУТРИ обработчика жеста.
    // -----------------------------------------------------------------
    ['click', 'touchend', 'keydown'].forEach(function (evt) {
        document.addEventListener(evt, function () {
            if (current && current.controller && current.controller.ctx && current.controller.ctx.state !== 'running') {
                console.log(LOG_PREFIX, 'жест пользователя (' + evt + '), пробую разблокировать AudioContext, было:', current.controller.ctx.state);
                current.controller.ctx.resume().then(function () {
                    console.log(LOG_PREFIX, 'AudioContext теперь:', current.controller.ctx.state);
                }).catch(function (err) {
                    console.warn(LOG_PREFIX, 'не удалось разблокировать AudioContext', err);
                });
            }
        }, true);
    });

    console.log(LOG_PREFIX, 'плагин v2.0 загружен');
})();
