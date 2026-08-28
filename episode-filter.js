/*
 * Фильтр раздач по номеру серии для панели "Торренты" в Lampa.
 *
 * Идея: в списке результатов поиска раздач у каждого элемента уже есть
 * распознанный из названия диапазон серий (element.general.episodes,
 * например "1-10" для сезонной пачки, "5-5"/"5" для одиночной серии,
 * null — если не распознано). Этот разбор делает сама Lampa
 * (components/torrents/parser.js) — плагин им пользуется, а не
 * переизобретает.
 *
 * Архитектура:
 *  - оборачиваем штатный компонент 'torrents' (Lampa.Component.get/add) —
 *    вся оригинальная логика поиска/рендера остаётся как есть, плагин
 *    только добавляет строку "Серия" в панель "Фильтр" и скрывает
 *    несовпадающие карточки;
 *  - у самого компонента список результатов (results/filtred) приватный —
 *    достучаться "напрямую" нельзя. Вместо этого слушаем событие
 *    Lampa.Listener('torrent', {type:'render', element, item}), которое
 *    Lampa шлёт на каждую отрисованную карточку, и скрываем/показываем её
 *    по факту (element.item — DOM/jQuery-элемент карточки);
 *  - если после фильтра осталось мало видимых карточек, а список ещё не
 *    кончился — дозапрашиваем следующую порцию через публичный this.next()
 *    (штатный метод подгрузки по скроллу), чтобы не выглядело как "пусто",
 *    когда совпадения просто ещё не отрисовались;
 *  - если диапазон серий не распознан (episodes == null) — карточку НЕ
 *    скрываем: лучше показать невыясненную раздачу, чем ошибочно спрятать
 *    релиз, который на самом деле содержит нужную серию.
 */
(function () {
    'use strict';
    if (!window.Lampa) return;

    var LOG_PREFIX = '[episode-filter]';
    var MAX_EPISODE = 60; // с запасом — длинные аниме-сезоны и т.п.
    var MIN_VISIBLE_BEFORE_AUTOLOAD = 5; // меньше — подгружаем ещё через this.next()

    var Original = Lampa.Component.get('torrents');
    if (!Original) {
        console.warn(LOG_PREFIX, 'компонент "torrents" не найден — не тот билд Lampa? плагин не активируется');
        return;
    }

    function parseEpisodeRange(rangeStr) {
        if (!rangeStr) return null;
        var parts = String(rangeStr).split('-');
        var from = parseInt(parts[0], 10);
        var to = parts.length > 1 ? parseInt(parts[parts.length - 1], 10) : from;
        if (isNaN(from)) return null;
        if (isNaN(to)) to = from;
        return { from: from, to: to };
    }

    function matchesEpisode(element, wanted) {
        if (!wanted) return true;
        var range = parseEpisodeRange(element && element.general && element.general.episodes);
        if (!range) return true; // не распознали — не скрываем, см. комментарий в шапке файла
        return wanted >= range.from && wanted <= range.to;
    }

    function toggleItemVisibility(item, show) {
        if (!item) return;
        try {
            if (item.toggleClass) item.toggleClass('hide-episode-filter', !show);
            else if (item.classList) item.classList.toggle('hide-episode-filter', !show);
        } catch (e) {}
    }

    // один общий style-блок на страницу вместо inline display:none — так
    // проще временно снять фильтр (просто убрать класс), не теряя разметку
    if (!document.getElementById('episode-filter-style')) {
        var style = document.createElement('style');
        style.id = 'episode-filter-style';
        style.textContent = '.hide-episode-filter{display:none !important;}';
        document.head.appendChild(style);
    }

    function TorrentsWithEpisodeFilter(object) {
        Original.call(this, object);
        var self = this;
        var wantedEpisode = null;
        var seen = []; // {element, item} — все карточки, что успели отрисоваться

        function applyFilterToAll() {
            var visible = 0;
            seen.forEach(function (pair) {
                var show = matchesEpisode(pair.element, wantedEpisode);
                toggleItemVisibility(pair.item, show);
                if (show) visible++;
            });
            if (wantedEpisode && visible < MIN_VISIBLE_BEFORE_AUTOLOAD && typeof self.next === 'function') {
                // список мог ещё не дорендерить достаточно совпадений —
                // просим штатный компонент подгрузить следующую порцию
                try { self.next(); } catch (e) {}
            }
        }

        function onTorrentEvent(e) {
            if (e.type !== 'render' || !e.element) return;
            seen.push({ element: e.element, item: e.item });
            if (wantedEpisode) toggleItemVisibility(e.item, matchesEpisode(e.element, wantedEpisode));
        }
        Lampa.Listener.follow('torrent', onTorrentEvent);

        var origDestroy = this.destroy;
        this.destroy = function () {
            Lampa.Listener.remove('torrent', onTorrentEvent);
            clearInterval(injectTimer);
            if (origDestroy) origDestroy.apply(this, arguments);
        };

        // Перед показом списка серий сначала дорендериваем ВСЕ уже найденные
        // раздачи (next() у Lampa раскрывает уже известный результат поиска
        // порциями, без сети — сам список раздач приходит одним запросом) и
        // собираем реальные номера серий из их element.general.episodes —
        // так в списке будут только серии, которые действительно где-то
        // присутствуют, а не жёстко 1..60.
        function collectKnownEpisodeNumbers() {
            var prevLen = -1, guard = 0;
            while (seen.length !== prevLen && guard < 200) {
                prevLen = seen.length;
                try { self.next(); } catch (e) { break; }
                guard++;
            }
            var nums = {};
            seen.forEach(function (pair) {
                var range = parseEpisodeRange(pair.element && pair.element.general && pair.element.general.episodes);
                if (!range) return;
                for (var n = range.from; n <= range.to && (n - range.from) < 200; n++) nums[n] = true;
            });
            return Object.keys(nums).map(Number).sort(function (a, b) { return a - b; });
        }

        function openEpisodePicker() {
            var known = collectKnownEpisodeNumbers();
            // если вообще ничего не распознали (редкий случай — все раздачи
            // без разбираемого номера серии в названии) — не оставляем
            // пользователя без выбора, показываем старый запасной диапазон
            var numbers = known.length ? known : Array.apply(null, { length: MAX_EPISODE }).map(function (_, i) { return i + 1; });
            var items = [{ title: Lampa.Lang.translate('torrent_parser_any_two') || 'Любая', value: null }];
            numbers.forEach(function (n) { items.push({ title: String(n), value: n, selected: n === wantedEpisode }); });
            Lampa.Select.show({
                title: 'Серия',
                items: items,
                onSelect: function (item) {
                    wantedEpisode = item.value;
                    applyFilterToAll();
                    updateRowLabel();
                    try { Lampa.Controller.toggle('content'); } catch (e) {}
                },
                onBack: function () {
                    try { Lampa.Controller.toggle('content'); } catch (e) {}
                }
            });
        }

        var $row = null;
        function updateRowLabel() {
            if (!$row) return;
            $row.find('.selectbox-item__subtitle').text(wantedEpisode ? String(wantedEpisode) : 'Любая');
        }

        // Панель "Фильтр" рендерится Lampa'ой динамически при каждом
        // открытии — ждём появления строки "Сезон" и вставляем свою сразу
        // после неё. Опрос вместо MutationObserver — проще и предсказуемее
        // при частом открытии/закрытии панели (тот же приём, что и в
        // Dub/dub.js для кнопки 🎙 в панели плеера).
        var injectTimer = setInterval(function () {
            if ($row && document.body.contains($row[0])) return; // уже вставлена и жива
            var $seasonTitle = $('.selectbox-item__title').filter(function () {
                return $(this).text().trim() === (Lampa.Lang.translate('torrent_parser_season') || 'Сезон');
            }).first();
            if (!$seasonTitle.length) return;
            var $seasonRow = $seasonTitle.closest('.selectbox-item');
            if (!$seasonRow.length || $seasonRow.next('.episode-filter-row').length) return;

            $row = $('<div class="selectbox-item selector episode-filter-row">' +
                '<div class="selectbox-item__title">Серия</div>' +
                '<div class="selectbox-item__subtitle">' + (wantedEpisode ? wantedEpisode : 'Любая') + '</div>' +
                '</div>');
            $row.on('hover:enter', openEpisodePicker);
            $row.on('click', openEpisodePicker);
            $seasonRow.after($row);
        }, 400);
    }

    TorrentsWithEpisodeFilter.prototype = Original.prototype;

    Lampa.Component.add('torrents', TorrentsWithEpisodeFilter);

    console.log(LOG_PREFIX, 'плагин загружен');
})();
