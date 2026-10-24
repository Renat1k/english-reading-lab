/* =========================================================
   A Strange Morning — interactive English lesson
   Reading canvas · TTS · quiz · SRS flashcards
   ========================================================= */

(() => {
  "use strict";

  const LESSON_URL = "./data/lesson.json";
  const STORAGE_KEY = "morning-lesson-v1";
  const THEME_KEY = "morning-theme";
  const DAY = 24 * 60 * 60 * 1000;
  const SRS_INTERVALS = [0, DAY, 3 * DAY, 7 * DAY];
  const RATES = [0.75, 1, 1.25];
  const WORD_RE = /[A-Za-z]+(?:['’][A-Za-z]+)?/g;
  const SENTENCE_RE = /[^.!?]+[.!?]+[”"']?(?=\s|$)|[^.!?]+$/g;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const state = {
    data: null,
    tokens: [],
    storyText: "",
    sentenceRanges: [],
    progress: null,
    storageBroken: false,
    quizCards: [],
    deck: {
      queue: [],
      index: 0,
      flipped: false,
      active: false,
      results: [],
      forgotten: [],
      allMode: false,
      action: null,
    },
    popover: {
      token: null,
      anchor: null,
      sheet: false,
      returnFocus: null,
    },
    tts: {
      supported:
        typeof window.speechSynthesis !== "undefined" &&
        typeof window.SpeechSynthesisUtterance !== "undefined",
      mode: "idle",
      rate: 1,
      currentIndex: -1,
      runId: 0,
      boundarySeen: false,
      fallbackProbe: null,
      fallbackTimer: null,
      utterance: null,
      voice: null,
      bodyOverflow: "",
    },
  };

  let toastTimer = null;
  let toastHideTimer = null;

  /* ---------- Boot ---------- */

  function init() {
    setupTheme();
    setupHeader();
    setupBaseEvents();
    loadLesson();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }

  async function loadLesson() {
    try {
      const response = await fetch(LESSON_URL, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`);
      }
      const data = await response.json();
      validateLesson(data);

      state.data = data;
      state.progress = loadProgress();
      state.tts.rate = state.progress.settings.rate;

      buildStory();
      renderMeta();
      renderSavedWords();
      renderQuiz();
      setupTTS();
      setupFlashcards();
      setupPopover();
      updateCompletionUI();
      updateAsideStats();

      document.body.classList.add("is-ready");
    } catch (error) {
      console.error("Could not load the lesson:", error);
      showAppError(error);
    }
  }

  function validateLesson(data) {
    if (!data || typeof data !== "object") throw new Error("lesson.json is not an object");
    if (!data.story || !Array.isArray(data.story.paragraphs) || !data.story.paragraphs.length) {
      throw new Error("lesson.json has no story paragraphs");
    }
    if (!data.dictionary || typeof data.dictionary !== "object") {
      throw new Error("lesson.json has no dictionary");
    }
    if (!Array.isArray(data.quiz) || !data.quiz.length) {
      throw new Error("lesson.json has no quiz");
    }
    if (!Array.isArray(data.flashcards) || !data.flashcards.length) {
      throw new Error("lesson.json has no flashcards");
    }
    data.quiz.forEach((question, index) => {
      if (!Array.isArray(question.options) || question.options.length < 2) {
        throw new Error(`Quiz question ${index + 1} has no options`);
      }
      if (!Number.isInteger(question.correct) || question.correct < 0 || question.correct >= question.options.length) {
        throw new Error(`Quiz question ${index + 1} has an invalid correct answer`);
      }
    });
    data.flashcards.forEach((card, index) => {
      if (!card || typeof card.word !== "string") {
        throw new Error(`Flashcard ${index + 1} has no word`);
      }
    });
  }

  function showAppError(error) {
    const box = $("#app-error");
    const text = $("#app-error-text");
    if (box) box.hidden = false;
    if (text) {
      if (window.location.protocol === "file:") {
        text.textContent =
          "Браузер не разрешает загружать data/lesson.json с локального диска. Запустите локальный сервер (например, python -m http.server 8080) или откройте сайт после деплоя.";
      } else {
        text.textContent = `Проверьте файл data/lesson.json и повторите попытку. ${error && error.message ? `Ошибка: ${error.message}.` : ""}`;
      }
    }

    ["reading", "quiz", "cards"].forEach((id) => {
      const section = document.getElementById(id);
      if (section) section.hidden = true;
    });
  }

  /* ---------- Theme ---------- */

  function setupTheme() {
    const initial = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
    applyTheme(initial, false);

    const button = $("#theme-toggle");
    if (!button) return;

    button.addEventListener("click", () => {
      const current = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
      const next = current === "dark" ? "light" : "dark";

      document.documentElement.classList.add("is-theme-changing");
      window.setTimeout(() => document.documentElement.classList.remove("is-theme-changing"), 360);

      applyTheme(next, true);
    });
  }

  function applyTheme(theme, persist) {
    document.documentElement.dataset.theme = theme;
    const label = theme === "dark" ? "Переключить на светлую тему" : "Переключить на тёмную тему";
    const button = $("#theme-toggle");
    if (button) {
      button.setAttribute("aria-label", label);
      button.setAttribute("title", label);
    }

    const meta = $("#meta-theme-color");
    if (meta) meta.setAttribute("content", theme === "dark" ? "#0D1117" : "#FDFBF7");

    if (persist) {
      try {
        localStorage.setItem(THEME_KEY, theme);
      } catch (error) {
        /* Theme still works for this visit. */
      }
    }
  }

  /* ---------- Header ---------- */

  function setupHeader() {
    const header = $("#site-header");
    if (!header) return;

    const onScroll = () => header.classList.toggle("is-scrolled", window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });

    const links = $$("[data-nav-link]");
    if (!links.length) return;

    const sections = links
      .map((link) => document.getElementById(link.dataset.navLink))
      .filter(Boolean);

    let scheduled = false;
    const updateActiveLink = () => {
      const headerHeight = Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue("--header-height")
      ) || 72;
      const offset = headerHeight + 34;
      let currentId = null;

      sections.forEach((section) => {
        if (section.getBoundingClientRect().top <= offset) currentId = section.id;
      });

      links.forEach((link) => {
        link.classList.toggle("is-active", link.dataset.navLink === currentId);
      });
    };

    const scheduleActiveLink = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        updateActiveLink();
      });
    };

    updateActiveLink();
    window.addEventListener("scroll", scheduleActiveLink, { passive: true });
    window.addEventListener("resize", scheduleActiveLink);
  }

  /* ---------- Loading state helpers ---------- */

  function setText(selector, value) {
    const node = $(selector);
    if (node) node.textContent = value;
  }

  function plural(number, one, few, many) {
    const n = Math.abs(number) % 100;
    const last = n % 10;
    if (n > 10 && n < 20) return many;
    if (last === 1) return one;
    if (last >= 2 && last <= 4) return few;
    return many;
  }

  function iconSvg(name, className = "icon") {
    return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
  }

  /* ---------- Story & tokens ---------- */

  function buildStory() {
    const paragraphs = state.data.story.paragraphs;
    const storyNode = $("#story");
    const fragment = document.createDocumentFragment();
    const tokens = [];
    let charOffset = 0;

    for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex += 1) {
      const paragraph = paragraphs[paragraphIndex];
      const p = document.createElement("p");
      p.className = "story-p";

      WORD_RE.lastIndex = 0;
      let lastIndex = 0;
      let match;

      while ((match = WORD_RE.exec(paragraph)) !== null) {
        if (match.index > lastIndex) {
          p.append(document.createTextNode(paragraph.slice(lastIndex, match.index)));
        }

        const word = match[0];
        const start = charOffset + match.index;
        const span = document.createElement("span");
        span.className = "word";
        span.textContent = word;
        span.dataset.key = normalizeWord(word);
        span.dataset.index = String(tokens.length);
        span.dataset.start = String(start);
        span.dataset.end = String(start + word.length);
        p.append(span);

        tokens.push({
          index: tokens.length,
          word,
          key: normalizeWord(word),
          start,
          end: start + word.length,
          paragraph: paragraphIndex,
          el: span,
        });

        lastIndex = match.index + word.length;
      }

      if (lastIndex < paragraph.length) {
        p.append(document.createTextNode(paragraph.slice(lastIndex)));
      }

      fragment.append(p);
      charOffset += paragraph.length + 2;
    }

    state.storyText = paragraphs.join("\n\n");
    state.tokens = tokens;
    state.sentenceRanges = buildSentenceRanges(state.storyText);

    storyNode.replaceChildren(fragment);
    storyNode.setAttribute("aria-busy", "false");
  }

  function normalizeWord(word) {
    return word.toLowerCase().replace(/’/g, "'");
  }

  function buildSentenceRanges(text) {
    const ranges = [];
    SENTENCE_RE.lastIndex = 0;
    let match;

    while ((match = SENTENCE_RE.exec(text)) !== null) {
      if (!match[0].trim()) continue;
      ranges.push({
        start: match.index,
        end: match.index + match[0].length,
        text: match[0],
      });
    }

    return ranges;
  }

  function findTokenAtChar(charIndex) {
    let low = 0;
    let high = state.tokens.length - 1;
    let result = state.tokens.length - 1;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const token = state.tokens[mid];
      if (token.end > charIndex) {
        result = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }

    return result;
  }

  function findTokenByKey(key) {
    return state.tokens.find((token) => token.key === key) || null;
  }

  function findSentenceForToken(token) {
    return (
      state.sentenceRanges.find((range) => token.start >= range.start && token.start < range.end) ||
      null
    );
  }

  function getDictionaryEntry(key) {
    const raw = state.data.dictionary[key];
    if (!raw) return null;
    return typeof raw === "string" ? { translation: raw } : raw;
  }

  function renderMeta() {
    const meta = state.data.meta || {};
    const wordCount = state.tokens.length;
    const cardCount = state.data.flashcards.length;
    const questionCount = state.data.quiz.length;

    setText("#hero-lead", meta.subtitle || "Тихое утро, чашка чая и записка, которая меняет всё.");
    setText("#hero-note", `“${meta.heroNote || "Do not go outside today."}”`);
    setText("#hero-note-caption", meta.heroNoteCaption || "записка на кухонном столе");
    setText("#hero-time", meta.heroTime || "07:00");
    setText("#meta-minutes", `~${meta.minutes || 8} минут`);
    setText("#meta-words", `${wordCount} ${plural(wordCount, "слово", "слова", "слов")}`);
    setText("#meta-cards", `${cardCount} ${plural(cardCount, "карточка", "карточки", "карточек")}`);
    setText("#reading-word-count", `${wordCount} ${plural(wordCount, "слово", "слова", "слов")}`);
    setText("#reading-level", meta.level || "A2");
    setText("#quiz-count-badge", `${questionCount} ${plural(questionCount, "вопрос", "вопроса", "вопросов")}`);
    setText("#cards-count-badge", `${cardCount} ${plural(cardCount, "карточка", "карточки", "карточек")}`);

    $$(".level-badge, .level-pill").forEach((badge) => {
      badge.textContent = meta.level || "A2";
    });

    document.title = `${meta.title || "A Strange Morning"} — урок английского`;
    const description =
      meta.subtitle || "Интерактивный урок английского: чтение, озвучка, квиз и карточки для повторения.";
    const descriptionMeta = document.querySelector('meta[name="description"]');
    if (descriptionMeta) descriptionMeta.setAttribute("content", description);

    const ttsPosition = $("#tts-position");
    if (ttsPosition) ttsPosition.textContent = `слово 0 / ${wordCount}`;
  }

  /* ---------- Progress storage ---------- */

  function createProgress() {
    return {
      version: 1,
      quiz: {
        answers: Array(state.data.quiz.length).fill(null),
        completed: false,
        score: 0,
        completedAt: null,
      },
      savedWords: [],
      cards: {},
      settings: { rate: 1 },
      updatedAt: null,
    };
  }

  function loadProgress() {
    const defaults = createProgress();
    let raw = null;

    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      raw = stored ? JSON.parse(stored) : null;
    } catch (error) {
      state.storageBroken = true;
      console.warn("Progress storage is unavailable:", error);
      return defaults;
    }

    if (!raw || typeof raw !== "object") return defaults;

    const rawAnswers = raw.quiz && Array.isArray(raw.quiz.answers) ? raw.quiz.answers : [];
    const answers = defaults.quiz.answers.map((_, index) => {
      const answer = rawAnswers[index];
      const question = state.data.quiz[index];
      return Number.isInteger(answer) && answer >= 0 && answer < question.options.length ? answer : null;
    });

    const answeredAll = answers.every((answer) => answer !== null);
    const score = answers.reduce((total, answer, index) => {
      return total + (answer === state.data.quiz[index].correct ? 1 : 0);
    }, 0);

    const savedWords = Array.isArray(raw.savedWords)
      ? [...new Set(raw.savedWords.filter((word) => typeof word === "string" && word.trim()).map((word) => word.trim()))]
      : [];

    const cards = {};
    if (raw.cards && typeof raw.cards === "object") {
      state.data.flashcards.forEach((card) => {
        const entry = raw.cards[card.word];
        if (!entry || typeof entry !== "object") return;
        const box = Number.isInteger(entry.box) ? Math.max(0, Math.min(3, entry.box)) : 0;
        const due = Number.isFinite(entry.due) ? entry.due : 0;
        const reviews = Number.isInteger(entry.reviews) && entry.reviews > 0 ? entry.reviews : 0;
        cards[card.word] = {
          box,
          due,
          reviews,
          lastRating: typeof entry.lastRating === "string" ? entry.lastRating : null,
          lastReviewedAt: Number.isFinite(entry.lastReviewedAt) ? entry.lastReviewedAt : null,
        };
      });
    }

    const storedRate = Number(raw.settings && raw.settings.rate);
    const rate = RATES.includes(storedRate) ? storedRate : 1;

    return {
      version: 1,
      quiz: {
        answers,
        completed: answeredAll,
        score,
        completedAt: answeredAll
          ? (raw.quiz && typeof raw.quiz.completedAt === "string" ? raw.quiz.completedAt : new Date().toISOString())
          : null,
      },
      savedWords,
      cards,
      settings: { rate },
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
    };
  }

  function saveProgress() {
    if (!state.progress) return;
    state.progress.updatedAt = new Date().toISOString();

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.progress));
    } catch (error) {
      state.storageBroken = true;
      console.warn("Could not save lesson progress:", error);
      const note = $(".privacy-note");
      if (note) {
        note.textContent = "Браузер не разрешает сохранение прогресса. Урок работает, но результаты не сохранятся после перезагрузки.";
      }
    }
  }

  function countCorrectAnswers() {
    return state.progress.quiz.answers.reduce((total, answer, index) => {
      return total + (answer === state.data.quiz[index].correct ? 1 : 0);
    }, 0);
  }

  /* ---------- Completion & stats ---------- */

  function updateCompletionUI() {
    if (!state.progress || !state.data) return;

    const total = state.data.quiz.length;
    const answered = state.progress.quiz.answers.filter((answer) => answer !== null).length;
    const score = state.progress.quiz.score;
    const chip = $("#hero-status");
    const label = $("#hero-status-text");

    if (chip && label) {
      chip.classList.toggle("is-done", state.progress.quiz.completed);
      if (state.progress.quiz.completed) {
        label.textContent = `Урок пройден · ${score}/${total}`;
      } else if (answered > 0) {
        label.textContent = `В процессе · ${answered}/${total}`;
      } else {
        label.textContent = "Урок не пройден";
      }
    }

    updateAsideStats();
  }

  function updateAsideStats() {
    if (!state.progress) return;
    const score = state.progress.quiz.score;
    const answered = state.progress.quiz.answers.filter((answer) => answer !== null).length;
    setText("#aside-saved", String(state.progress.savedWords.length));
    setText("#aside-quiz", answered ? `${score}/${state.data.quiz.length}` : "—");
  }

  /* ---------- Saved words ---------- */

  function renderSavedWords() {
    if (!state.progress) return;

    const keys = state.progress.savedWords;
    const count = keys.length;
    const panel = $("#saved-words");
    const clear = $("#clear-saved");

    setText("#saved-count", String(count));
    setText("#saved-head-count", String(count));
    setText("#aside-saved", String(count));

    if (panel) panel.hidden = count === 0;
    if (clear) clear.hidden = count === 0;

    const chips = $("#saved-chips");
    if (chips) {
      const fragment = document.createDocumentFragment();
      keys.forEach((key) => {
        const entry = getDictionaryEntry(key);
        const token = findTokenByKey(key);
        const displayWord = token ? token.word : key;
        const shortTranslation = entry && entry.translation
          ? entry.translation.split(",")[0].trim()
          : "слово из истории";

        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "saved-chip";
        chip.title = entry ? `${displayWord} — ${entry.translation}` : displayWord;
        chip.append(document.createTextNode(displayWord));

        const translation = document.createElement("span");
        translation.textContent = shortTranslation;
        chip.append(translation);

        chip.addEventListener("click", () => {
          if (token) openPopoverForToken(token, chip);
        });

        fragment.append(chip);
      });
      chips.replaceChildren(fragment);
    }

    const savedSet = new Set(keys);
    state.tokens.forEach((token) => {
      token.el.classList.toggle("is-saved", savedSet.has(token.key));
    });
  }

  function toggleSavedWord(key, displayWord) {
    if (!state.progress) return;
    const index = state.progress.savedWords.indexOf(key);
    let action;

    if (index >= 0) {
      state.progress.savedWords.splice(index, 1);
      action = "removed";
    } else {
      state.progress.savedWords.unshift(key);
      action = "saved";
    }

    saveProgress();
    renderSavedWords();
    updatePopoverSaveState();

    if (action === "saved") {
      showToast(`«${displayWord}» добавлено в словарь`);
    } else {
      showToast(`«${displayWord}» убрано из словаря`);
    }
  }

  /* ---------- Popover ---------- */

  function setupPopover() {
    const story = $("#story");
    if (story) {
      story.addEventListener("click", (event) => {
        if (window.getSelection && window.getSelection().toString().trim()) return;
        const word = event.target.closest(".word");
        if (!word) return;
        const index = Number(word.dataset.index);
        const token = state.tokens[index];
        if (token) openPopoverForToken(token, word);
      });
    }

    const close = $("#popover-close");
    if (close) close.addEventListener("click", () => closePopover());

    const scrim = $("#popover-scrim");
    if (scrim) {
      scrim.addEventListener("click", () => closePopover({ restoreFocus: false }));
    }

    const save = $("#popover-save");
    if (save) {
      save.addEventListener("click", () => {
        if (!state.popover.token) return;
        toggleSavedWord(state.popover.token.key, state.popover.token.word);
      });
    }

    const clear = $("#clear-saved");
    if (clear) {
      clear.addEventListener("click", () => {
        if (!state.progress || !state.progress.savedWords.length) return;
        if (!window.confirm("Очистить словарь? Сохранённые слова будут удалены.")) return;
        state.progress.savedWords = [];
        saveProgress();
        renderSavedWords();
        updatePopoverSaveState();
        showToast("Словарь очищен");
      });
    }

    document.addEventListener("pointerdown", (event) => {
      if ($("#word-popover")?.hidden) return;
      if (event.target.closest("#word-popover") || event.target.closest(".word") || event.target.closest(".saved-chip")) {
        return;
      }
      closePopover({ restoreFocus: false });
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && $("#word-popover") && !$("#word-popover").hidden) {
        closePopover();
      }
    });

    window.addEventListener("scroll", () => {
      const popover = $("#word-popover");
      if (popover && !popover.hidden && !state.popover.sheet) closePopover({ restoreFocus: false });
    }, { passive: true });

    window.addEventListener("resize", () => {
      const popover = $("#word-popover");
      if (popover && !popover.hidden) closePopover({ restoreFocus: false });
    });
  }

  function openPopoverForToken(token, anchor) {
    if (!token) return;
    closePopover({ restoreFocus: false, silent: true });

    const popover = $("#word-popover");
    const entry = getDictionaryEntry(token.key) || {
      translation: "Перевод пока не добавлен.",
    };

    state.popover.token = token;
    state.popover.anchor = anchor || token.el;
    state.popover.returnFocus = token.el || anchor || null;

    state.tokens.forEach((item) => item.el.classList.remove("is-selected"));
    token.el.classList.add("is-selected");
    token.el.setAttribute("tabindex", "-1");

    setText("#popover-word", token.word);
    const metaParts = [entry.ipa, entry.pos].filter(Boolean);
    setText("#popover-meta", metaParts.length ? metaParts.join(" · ") : "A2 · контекстный перевод");
    setText("#popover-translation", entry.translation || "Перевод пока не добавлен.");
    setText("#popover-note", entry.note || "");

    const base = $("#popover-base");
    if (base) {
      if (entry.base) {
        base.textContent = `Начальная форма: ${entry.base}`;
        base.hidden = false;
      } else {
        base.hidden = true;
        base.textContent = "";
      }
    }

    const noteWrap = $("#popover-note-wrap");
    if (noteWrap) noteWrap.hidden = !entry.note;

    renderPopoverContext(token);
    updatePopoverSaveState();

    popover.hidden = false;
    const isSheet = window.innerWidth <= 640;
    state.popover.sheet = isSheet;
    popover.classList.toggle("is-sheet", isSheet);
    popover.setAttribute("aria-modal", isSheet ? "true" : "false");

    const scrim = $("#popover-scrim");
    if (isSheet) {
      if (scrim) {
        scrim.hidden = false;
        requestAnimationFrame(() => scrim.classList.add("is-visible"));
      }
      if (!document.body.classList.contains("popover-open")) {
        state.tts.bodyOverflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        document.body.classList.add("popover-open");
      }
    } else if (scrim) {
      scrim.hidden = true;
      scrim.classList.remove("is-visible");
    }

    popover.style.visibility = isSheet ? "" : "hidden";

    requestAnimationFrame(() => {
      if (isSheet) {
        popover.focus({ preventScroll: true });
      } else {
        positionPopover(anchor || token.el);
        popover.style.visibility = "";
        popover.focus({ preventScroll: true });
      }
    });
  }

  function positionPopover(anchor) {
    const popover = $("#word-popover");
    if (!popover || !anchor) return;

    const margin = 12;
    const gap = 10;
    const anchorRect = anchor.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let left = anchorRect.left + anchorRect.width / 2 - popoverRect.width / 2;
    left = Math.max(margin, Math.min(left, viewportWidth - popoverRect.width - margin));

    let top = anchorRect.bottom + gap;
    if (top + popoverRect.height > viewportHeight - margin) {
      const above = anchorRect.top - popoverRect.height - gap;
      top = above >= margin ? above : Math.max(margin, viewportHeight - popoverRect.height - margin);
    }

    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
  }

  function renderPopoverContext(token) {
    const context = $("#popover-context");
    if (!context) return;
    context.replaceChildren();

    const range = findSentenceForToken(token);
    if (!range) {
      context.textContent = state.data.story.paragraphs[token.paragraph] || "";
      return;
    }

    const raw = range.text;
    const leading = raw.length - raw.trimStart().length;
    const sentence = raw.trim();
    let startInSentence = token.start - range.start - leading;

    if (startInSentence < 0 || startInSentence >= sentence.length) {
      startInSentence = sentence.toLowerCase().indexOf(token.word.toLowerCase());
    }

    if (startInSentence < 0) {
      context.textContent = sentence;
      return;
    }

    const before = sentence.slice(0, startInSentence);
    const word = sentence.slice(startInSentence, startInSentence + token.word.length);
    const after = sentence.slice(startInSentence + token.word.length);

    context.append(document.createTextNode(before));
    const mark = document.createElement("mark");
    mark.textContent = word;
    context.append(mark, document.createTextNode(after));
  }

  function updatePopoverSaveState() {
    const button = $("#popover-save");
    const label = $("#popover-save-label");
    if (!button || !state.popover.token || !state.progress) return;

    const saved = state.progress.savedWords.includes(state.popover.token.key);
    button.classList.toggle("is-saved", saved);
    button.setAttribute("aria-pressed", saved ? "true" : "false");
    if (label) label.textContent = saved ? "Убрать из словаря" : "Сохранить слово";
  }

  function closePopover(options = {}) {
    const popover = $("#word-popover");
    if (!popover || popover.hidden) return;

    const hadFocus = popover.contains(document.activeElement) || document.activeElement === popover;
    const returnFocus = state.popover.returnFocus;

    popover.hidden = true;
    popover.classList.remove("is-sheet");
    popover.style.visibility = "";
    popover.style.left = "";
    popover.style.top = "";

    const scrim = $("#popover-scrim");
    if (scrim) {
      scrim.classList.remove("is-visible");
      scrim.hidden = true;
    }

    document.body.style.overflow = state.tts.bodyOverflow || "";
    document.body.classList.remove("popover-open");

    if (state.popover.token) {
      state.popover.token.el.classList.remove("is-selected");
    }

    state.popover.token = null;
    state.popover.anchor = null;
    state.popover.sheet = false;

    if (
      options.restoreFocus !== false &&
      hadFocus &&
      returnFocus &&
      typeof returnFocus.focus === "function"
    ) {
      window.setTimeout(() => returnFocus.focus({ preventScroll: true }), 0);
    }
  }

  /* ---------- Quiz ---------- */

  function renderQuiz() {
    const list = $("#quiz-list");
    if (!list) return;

    list.replaceChildren();
    state.quizCards = [];

    const fragment = document.createDocumentFragment();

    state.data.quiz.forEach((question, questionIndex) => {
      const card = document.createElement("article");
      card.className = "quiz-card";

      const head = document.createElement("div");
      head.className = "quiz-question";

      const number = document.createElement("span");
      number.className = "quiz-number";
      number.textContent = String(questionIndex + 1).padStart(2, "0");

      const title = document.createElement("h3");
      title.textContent = question.question;

      head.append(number, title);

      const optionsWrap = document.createElement("div");
      optionsWrap.className = "quiz-options";

      const options = [];
      question.options.forEach((optionText, optionIndex) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "quiz-option";

        const letter = document.createElement("span");
        letter.className = "option-letter";
        letter.textContent = String.fromCharCode(65 + optionIndex);

        const text = document.createElement("span");
        text.className = "option-text";
        text.textContent = optionText;

        const mark = document.createElement("span");
        mark.className = "option-mark";
        mark.setAttribute("aria-hidden", "true");

        button.append(letter, text, mark);
        button.addEventListener("click", () => answerQuiz(questionIndex, optionIndex));
        options.push(button);
        optionsWrap.append(button);
      });

      const feedback = document.createElement("div");
      feedback.className = "quiz-feedback";
      feedback.hidden = true;
      feedback.setAttribute("role", "status");

      const feedbackIcon = document.createElement("span");
      feedbackIcon.className = "feedback-icon";

      const feedbackCopy = document.createElement("div");
      feedbackCopy.className = "feedback-copy";
      const feedbackTitle = document.createElement("strong");
      const feedbackText = document.createElement("p");
      feedbackCopy.append(feedbackTitle, feedbackText);

      feedback.append(feedbackIcon, feedbackCopy);

      card.append(head, optionsWrap, feedback);
      fragment.append(card);

      state.quizCards.push({
        card,
        options,
        feedback,
        feedbackIcon,
        feedbackTitle,
        feedbackText,
      });
    });

    list.append(fragment);
    syncQuizUI();

    const restart = $("#quiz-restart");
    if (restart && !restart.dataset.bound) {
      restart.dataset.bound = "true";
      restart.addEventListener("click", resetQuiz);
    }
  }

  function answerQuiz(questionIndex, optionIndex) {
    if (!state.progress) return;
    if (state.progress.quiz.answers[questionIndex] !== null) return;

    const question = state.data.quiz[questionIndex];
    state.progress.quiz.answers[questionIndex] = optionIndex;
    state.progress.quiz.score = countCorrectAnswers();

    const allAnswered = state.progress.quiz.answers.every((answer) => answer !== null);
    if (allAnswered) {
      state.progress.quiz.completed = true;
      state.progress.quiz.completedAt = new Date().toISOString();
    }

    syncQuizQuestion(questionIndex);
    syncQuizSummary();
    updateCompletionUI();
    saveProgress();

    if (allAnswered) {
      const score = state.progress.quiz.score;
      showToast(`Квиз завершён: ${score} из ${state.data.quiz.length}`);
    }
  }

  function syncQuizUI() {
    if (!state.progress) return;
    state.data.quiz.forEach((_, index) => syncQuizQuestion(index));
    syncQuizSummary();
  }

  function syncQuizQuestion(questionIndex) {
    const refs = state.quizCards[questionIndex];
    if (!refs) return;

    const question = state.data.quiz[questionIndex];
    const answer = state.progress.quiz.answers[questionIndex];
    const answered = answer !== null;
    const isCorrect = answered && answer === question.correct;

    refs.card.classList.toggle("is-correct", Boolean(isCorrect));
    refs.card.classList.toggle("is-wrong", answered && !isCorrect);

    refs.options.forEach((button, optionIndex) => {
      button.classList.remove("is-correct", "is-wrong", "is-muted");
      button.disabled = answered;
      button.removeAttribute("aria-pressed");

      const mark = button.querySelector(".option-mark");

      if (!answered) {
        if (mark) mark.replaceChildren();
        return;
      }

      if (optionIndex === question.correct) {
        button.classList.add("is-correct");
        button.setAttribute("aria-pressed", "true");
        if (mark) mark.innerHTML = iconSvg("check");
      } else if (optionIndex === answer) {
        button.classList.add("is-wrong");
        button.setAttribute("aria-pressed", "true");
        if (mark) mark.innerHTML = iconSvg("x");
      } else {
        button.classList.add("is-muted");
        if (mark) mark.replaceChildren();
      }
    });

    if (!answered) {
      refs.feedback.hidden = true;
      refs.feedback.className = "quiz-feedback";
      return;
    }

    refs.feedback.hidden = false;
    refs.feedback.className = `quiz-feedback ${isCorrect ? "is-correct" : "is-wrong"}`;
    refs.feedbackIcon.innerHTML = iconSvg(isCorrect ? "check" : "x");
    refs.feedbackTitle.textContent = isCorrect ? "Верно!" : "Не совсем";
    refs.feedbackText.textContent = question.explanation;
  }

  function syncQuizSummary() {
    if (!state.progress) return;
    const total = state.data.quiz.length;
    const answers = state.progress.quiz.answers;
    const answered = answers.filter((answer) => answer !== null).length;
    const score = state.progress.quiz.score;
    const completed = state.progress.quiz.completed;

    setText("#quiz-score", `${score} / ${total}`);
    setText("#aside-quiz", answered ? `${score}/${total}` : "—");

    const dial = $("#quiz-dial");
    if (dial) dial.style.setProperty("--pct", String(total ? Math.round((score / total) * 100) : 0));

    const progress = $("#quiz-progress-fill");
    if (progress) progress.style.width = `${total ? Math.round((answered / total) * 100) : 0}%`;

    const badge = $("#quiz-status-badge");
    if (badge) {
      badge.classList.toggle("is-done", completed);
      badge.textContent = completed ? "Пройден" : answered ? "В процессе" : "Не начат";
    }

    const title = $("#quiz-summary-title");
    const text = $("#quiz-summary-text");

    if (completed) {
      if (title) {
        title.textContent =
          score === total ? "Идеальное понимание" : score >= Math.ceil(total * 0.6) ? "Хороший результат" : "Есть над чем поработать";
      }
      if (text) {
        text.textContent = `Правильных ответов: ${score} из ${total}. Результат сохранён в этом браузере — можно вернуться к разбору в любой момент.`;
      }
    } else if (answered > 0) {
      if (title) title.textContent = `Отвечено ${answered} из ${total}`;
      if (text) text.textContent = "Продолжайте: после каждого ответа появляется объяснение. Прогресс сохраняется автоматически.";
    } else {
      if (title) title.textContent = "Проверьте, как вы поняли историю";
      if (text) text.textContent = "Выберите один вариант в каждом вопросе. Результат сохранится в браузере.";
    }

    const result = $("#quiz-result");
    if (result) {
      result.hidden = !completed;
      if (completed) {
        setText("#quiz-result-title", `Квиз пройден · ${score} из ${total}`);
        setText("#quiz-result-text", resultMessage(score, total));
      }
    }

    updateCompletionUI();
  }

  function resultMessage(score, total) {
    if (score === total) {
      return "Все ответы верные. Отличная работа — текст понят полностью.";
    }
    if (score >= Math.ceil(total * 0.6)) {
      return "Квиз пройден. Загляните в объяснения к ошибкам и попробуйте перечитать самые важные абзацы.";
    }
    return "Квиз пройден, но есть что улучшить. Перечитайте историю и пройдите его ещё раз — результат обновится.";
  }

  function resetQuiz() {
    if (!state.progress) return;

    state.progress.quiz = {
      answers: Array(state.data.quiz.length).fill(null),
      completed: false,
      score: 0,
      completedAt: null,
    };

    saveProgress();
    renderQuiz();
    updateCompletionUI();
    showToast("Квиз начнётся заново");

    const quiz = $("#quiz");
    if (quiz) {
      quiz.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        block: "start",
      });
    }
  }

  /* ---------- TTS ---------- */

  function setupTTS() {
    const player = $("#tts-player");
    const toggle = $("#tts-toggle");
    if (!player || !toggle) return;

    setRate(state.progress.settings.rate, false);
    updateTTSPlayer();

    if (!state.tts.supported) {
      toggle.disabled = true;
      $$(".speed-pills button").forEach((button) => {
        button.disabled = true;
      });
      setText("#tts-status", "Озвучка недоступна в этом браузере");
      return;
    }

    loadVoices();
    if (typeof window.speechSynthesis.addEventListener === "function") {
      window.speechSynthesis.addEventListener("voiceschanged", loadVoices);
    }

    toggle.addEventListener("click", () => {
      if (state.tts.mode === "playing") {
        pauseSpeech();
      } else if (state.tts.mode === "paused") {
        startSpeech(state.tts.currentIndex);
      } else {
        startSpeech(0);
      }
    });

    $$(".speed-pills button").forEach((button) => {
      button.addEventListener("click", () => {
        const rate = Number(button.dataset.rate);
        if (RATES.includes(rate)) setRate(rate, true);
      });
    });

    window.addEventListener("pagehide", cancelSpeech);
  }

  function loadVoices() {
    if (!state.tts.supported) return;
    const voices = window.speechSynthesis.getVoices();
    const english = voices.filter((voice) => /^en([-_]|$)/i.test(voice.lang));

    state.tts.voice =
      english.find(
        (voice) =>
          /en-US/i.test(voice.lang) &&
          /google|aria|jenny|samantha|alex|natural|neural/i.test(voice.name)
      ) ||
      english.find((voice) => /en-US/i.test(voice.lang)) ||
      english.find((voice) => /en-GB/i.test(voice.lang)) ||
      english[0] ||
      null;
  }

  function setRate(rate, restart) {
    const nextRate = RATES.includes(Number(rate)) ? Number(rate) : 1;
    const wasPlaying = state.tts.mode === "playing";
    const wasPaused = state.tts.mode === "paused";
    const resumeIndex = Math.max(0, state.tts.currentIndex);

    if (wasPlaying) {
      cancelSpeech();
    }

    state.tts.rate = nextRate;
    if (state.progress) {
      state.progress.settings.rate = nextRate;
      saveProgress();
    }
    updateSpeedPills();

    if (wasPlaying && restart) {
      startSpeech(resumeIndex);
    } else if (wasPaused) {
      updateTTSPlayer();
    }
  }

  function updateSpeedPills() {
    $$(".speed-pills button").forEach((button) => {
      const active = Number(button.dataset.rate) === state.tts.rate;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
  }

  function startSpeech(fromIndex) {
    if (!state.tts.supported || !state.tokens.length) return;

    const index = Number.isInteger(fromIndex) && fromIndex >= 0 && fromIndex < state.tokens.length ? fromIndex : 0;
    const startChar = state.tokens[index].start;
    const text = state.storyText.slice(startChar);

    state.tts.runId += 1;
    const run = state.tts.runId;

    try {
      window.speechSynthesis.cancel();
    } catch (error) {
      /* ignore */
    }

    clearFallback();
    state.tts.boundarySeen = false;
    state.tts.mode = "playing";
    state.tts.currentIndex = index;

    const utterance = new window.SpeechSynthesisUtterance(text);
    utterance.lang = "en-US";
    utterance.rate = state.tts.rate;
    if (state.tts.voice) utterance.voice = state.tts.voice;

    utterance.onstart = () => {
      if (run !== state.tts.runId) return;
      state.tts.mode = "playing";
      updateTTSPlayer();
    };

    utterance.onboundary = (event) => {
      if (run !== state.tts.runId) return;
      if (!Number.isFinite(event.charIndex)) return;

      state.tts.boundarySeen = true;
      clearFallback();

      const absoluteChar = startChar + event.charIndex;
      const tokenIndex = findTokenAtChar(absoluteChar);
      setActiveWord(tokenIndex);
    };

    utterance.onend = () => {
      if (run !== state.tts.runId) return;
      finishSpeech();
    };

    utterance.onerror = (event) => {
      if (run !== state.tts.runId) return;
      if (event.error === "interrupted" || event.error === "canceled") return;

      console.warn("Speech synthesis error:", event.error);
      failSpeech("Не удалось включить озвучку");
    };

    state.tts.utterance = utterance;
    setActiveWord(index);
    updateTTSPlayer();
    scheduleFallback(run, index);

    try {
      window.speechSynthesis.speak(utterance);
    } catch (error) {
      console.warn("Could not start speech synthesis:", error);
      failSpeech("Озвучка недоступна в этом браузере");
    }
  }

  function failSpeech(message) {
    clearFallback();
    clearActiveWord();
    state.tts.mode = "idle";

    const fill = $("#tts-progress");
    if (fill) fill.style.width = "0%";
    const position = $("#tts-position");
    if (position && state.tokens.length) position.textContent = `слово 0 / ${state.tokens.length}`;

    updateTTSPlayer();
    setText("#tts-status", message);
    showToast(message);
  }

  function pauseSpeech() {
    if (state.tts.mode !== "playing" || !state.tts.supported) return;

    state.tts.runId += 1;
    try {
      window.speechSynthesis.cancel();
    } catch (error) {
      /* ignore */
    }
    clearFallback();
    state.tts.mode = "paused";
    updateTTSPlayer();
  }

  function finishSpeech() {
    clearFallback();
    clearActiveWord();
    state.tts.mode = "finished";

    const position = $("#tts-position");
    if (position && state.tokens.length) {
      position.textContent = "готово";
    }
    const fill = $("#tts-progress");
    if (fill) fill.style.width = "100%";
    updateTTSPlayer();
  }

  function cancelSpeech() {
    state.tts.runId += 1;
    clearFallback();
    try {
      window.speechSynthesis.cancel();
    } catch (error) {
      /* ignore */
    }
    state.tts.mode = "idle";
    clearActiveWord();
    if (state.tokens.length) {
      const fill = $("#tts-progress");
      if (fill) fill.style.width = "0%";
      const position = $("#tts-position");
      if (position) position.textContent = `слово 0 / ${state.tokens.length}`;
    }
    updateTTSPlayer();
  }

  function updateTTSPlayer() {
    const player = $("#tts-player");
    const toggle = $("#tts-toggle");
    if (!player || !toggle) return;

    if (!state.tts.supported) {
      player.classList.remove("is-playing", "is-paused");
      toggle.setAttribute("aria-label", "Озвучка недоступна в этом браузере");
      toggle.setAttribute("title", "Озвучка недоступна");
      const unsupportedStatus = $("#tts-status");
      if (unsupportedStatus) unsupportedStatus.textContent = "Озвучка недоступна в этом браузере";
      return;
    }

    player.classList.toggle("is-playing", state.tts.mode === "playing");
    player.classList.toggle("is-paused", state.tts.mode === "paused");

    const label =
      state.tts.mode === "playing"
        ? "Пауза"
        : state.tts.mode === "paused"
          ? "Продолжить"
          : "Слушать историю";
    toggle.setAttribute("aria-label", label);
    toggle.setAttribute("title", label);

    const status = $("#tts-status");
    if (status) {
      status.textContent =
        state.tts.mode === "playing"
          ? "Слушаем историю"
          : state.tts.mode === "paused"
            ? "Пауза"
            : state.tts.mode === "finished"
              ? "История прочитана"
              : "Слушать историю";
    }
  }

  function setActiveWord(index) {
    if (!state.tokens[index]) return;

    if (state.tts.currentIndex >= 0 && state.tokens[state.tts.currentIndex]) {
      state.tokens[state.tts.currentIndex].el.classList.remove("is-speaking");
    }

    state.tts.currentIndex = index;
    state.tokens[index].el.classList.add("is-speaking");

    const position = $("#tts-position");
    if (position) position.textContent = `слово ${index + 1} / ${state.tokens.length}`;

    const fill = $("#tts-progress");
    if (fill) fill.style.width = `${Math.round(((index + 1) / state.tokens.length) * 100)}%`;
  }

  function clearActiveWord() {
    if (state.tts.currentIndex >= 0 && state.tokens[state.tts.currentIndex]) {
      state.tokens[state.tts.currentIndex].el.classList.remove("is-speaking");
    }
    state.tts.currentIndex = -1;
  }

  function scheduleFallback(run, startIndex) {
    clearFallbackProbe();
    state.tts.fallbackProbe = window.setTimeout(() => {
      if (run !== state.tts.runId || state.tts.mode !== "playing" || state.tts.boundarySeen) return;
      startFallback(run, startIndex);
    }, 750);
  }

  function startFallback(run, startIndex) {
    clearFallback();
    const total = state.tokens.length - startIndex;
    if (total <= 0) return;

    const wordsPerMinute = Math.max(90, 155 * state.tts.rate);
    const duration = (total / (wordsPerMinute / 60)) * 1000;
    const startedAt = performance.now();

    state.tts.fallbackTimer = window.setInterval(() => {
      if (run !== state.tts.runId || state.tts.mode !== "playing") {
        clearFallback();
        return;
      }

      const elapsed = performance.now() - startedAt;
      const progressIndex = Math.min(
        state.tokens.length - 1,
        startIndex + Math.floor((elapsed / duration) * total)
      );
      setActiveWord(progressIndex);
    }, 120);
  }

  function clearFallback() {
    clearFallbackProbe();
    if (state.tts.fallbackTimer) {
      window.clearInterval(state.tts.fallbackTimer);
      state.tts.fallbackTimer = null;
    }
  }

  function clearFallbackProbe() {
    if (state.tts.fallbackProbe) {
      window.clearTimeout(state.tts.fallbackProbe);
      state.tts.fallbackProbe = null;
    }
  }

  /* ---------- Flashcards ---------- */

  function setupFlashcards() {
    const flashcard = $("#flashcard");
    const forgot = $("#card-forgot");
    const remember = $("#card-remember");
    const stateButton = $("#deck-state-button");

    if (!flashcard || !forgot || !remember) return;

    flashcard.addEventListener("click", toggleFlashcard);
    flashcard.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggleFlashcard();
      }
    });

    forgot.addEventListener("click", () => rateCard("forgot"));
    remember.addEventListener("click", () => rateCard("remember"));

    if (stateButton) {
      stateButton.addEventListener("click", () => {
        if (typeof state.deck.action === "function") state.deck.action();
      });
    }

    startDeck();
  }

  function startDeck(cards, options = {}) {
    const queue = Array.isArray(cards) ? cards.slice() : getDueCards();

    if (!queue.length) {
      showDeckIdle();
      return;
    }

    state.deck = {
      queue,
      index: 0,
      flipped: false,
      active: true,
      results: Array(queue.length).fill(null),
      forgotten: [],
      allMode: Boolean(options.all),
      action: null,
    };

    const flashcard = $("#flashcard");
    const deckState = $("#deck-state");
    const actions = $(".deck-actions");
    const hint = $("#deck-hint");
    const dots = $("#deck-dots");

    if (flashcard) flashcard.hidden = false;
    if (deckState) deckState.hidden = true;
    if (actions) actions.hidden = false;
    if (hint) hint.hidden = false;
    if (dots) dots.hidden = false;

    renderCurrentCard();
  }

  function getDueCards() {
    if (!state.progress) return [];
    const now = Date.now();
    return state.data.flashcards.filter((card) => {
      const entry = state.progress.cards[card.word];
      return !entry || !Number.isFinite(entry.due) || entry.due <= now;
    });
  }

  function renderCurrentCard() {
    if (!state.deck.active) return;
    if (state.deck.index >= state.deck.queue.length) {
      finishDeck();
      return;
    }

    const card = state.deck.queue[state.deck.index];
    if (!card) return;

    const flashcard = $("#flashcard");

    // New card: reset the flip without showing the next answer during the animation.
    if (flashcard && flashcard.classList.contains("is-flipped")) {
      const inner = $(".flashcard-inner");
      if (inner) inner.style.transition = "none";
      flashcard.classList.remove("is-flipped");
      void flashcard.offsetWidth;
      if (inner) inner.style.transition = "";
    }

    setText("#card-word", card.word);
    setText("#card-ipa", card.ipa || "");
    setText("#card-pos", card.pos || "");
    setText("#card-translation", card.translation || "");
    setText("#card-example", card.example || "");
    setText("#card-example-ru", card.exampleRu || "");
    setText("#card-counter", `${state.deck.index + 1} / ${state.deck.queue.length}`);
    setText("#deck-due-text", state.deck.allMode ? "дополнительное повторение" : "к повторению сегодня");

    const ipa = $("#card-ipa");
    if (ipa) ipa.hidden = !card.ipa;
    const pos = $("#card-pos");
    if (pos) pos.hidden = !card.pos;

    if (flashcard) {
      flashcard.classList.remove("is-flipped");
      flashcard.setAttribute("aria-pressed", "false");
      flashcard.setAttribute("aria-label", `Карточка ${state.deck.index + 1}: перевернуть`);
    }
    syncFlashcardSides(false);
    state.deck.flipped = false;
    const forgot = $("#card-forgot");
    const remember = $("#card-remember");
    if (forgot) forgot.disabled = true;
    if (remember) remember.disabled = true;
    setText("#deck-hint", "Сначала переверните карточку, затем оцените себя.");

    renderDeckDots();
  }

  function syncFlashcardSides(flipped) {
    const front = $(".flashcard-front");
    const back = $(".flashcard-back");
    if (front) front.setAttribute("aria-hidden", flipped ? "true" : "false");
    if (back) back.setAttribute("aria-hidden", flipped ? "false" : "true");
  }

  function toggleFlashcard() {
    if (!state.deck.active || state.deck.index >= state.deck.queue.length) return;

    state.deck.flipped = !state.deck.flipped;

    const flashcard = $("#flashcard");
    if (flashcard) {
      flashcard.classList.toggle("is-flipped", state.deck.flipped);
      flashcard.setAttribute("aria-pressed", state.deck.flipped ? "true" : "false");
    }
    syncFlashcardSides(state.deck.flipped);

    const forgot = $("#card-forgot");
    const remember = $("#card-remember");
    if (forgot) forgot.disabled = !state.deck.flipped;
    if (remember) remember.disabled = !state.deck.flipped;

    setText(
      "#deck-hint",
      state.deck.flipped ? "Получилось вспомнить? Оцените себя." : "Сначала переверните карточку, затем оцените себя."
    );
  }

  function rateCard(rating) {
    if (!state.deck.active || !state.deck.flipped || !state.progress) return;

    const card = state.deck.queue[state.deck.index];
    if (!card) return;

    const now = Date.now();
    const existing = state.progress.cards[card.word] || { box: 0, reviews: 0 };
    let box;
    let due;

    if (rating === "remember") {
      box = Math.min(3, (Number.isInteger(existing.box) ? existing.box : 0) + 1);
      due = now + SRS_INTERVALS[box];
    } else {
      box = 0;
      due = now;
    }

    state.progress.cards[card.word] = {
      box,
      due,
      reviews: (Number.isInteger(existing.reviews) ? existing.reviews : 0) + 1,
      lastRating: rating,
      lastReviewedAt: now,
    };

    state.deck.results[state.deck.index] = rating;
    if (rating === "forgot") state.deck.forgotten.push(card);

    saveProgress();
    state.deck.index += 1;
    state.deck.flipped = false;

    if (state.deck.index >= state.deck.queue.length) {
      finishDeck();
    } else {
      renderCurrentCard();
      const flashcard = $("#flashcard");
      if (flashcard) flashcard.focus({ preventScroll: true });
    }
  }

  function renderDeckDots() {
    const dots = $("#deck-dots");
    if (!dots) return;

    dots.replaceChildren();
    state.deck.queue.forEach((_, index) => {
      const dot = document.createElement("span");
      if (index === state.deck.index) {
        dot.classList.add("is-current");
      } else if (state.deck.results[index] === "remember") {
        dot.classList.add("is-done");
      } else if (state.deck.results[index] === "forgot") {
        dot.classList.add("is-forgotten");
      }
      dots.append(dot);
    });
  }

  function finishDeck() {
    const total = state.deck.queue.length;
    const remembered = state.deck.results.filter((result) => result === "remember").length;
    const forgotten = state.deck.forgotten.slice();
    const forgottenCount = state.deck.results.filter((result) => result === "forgot").length;

    state.deck.active = false;
    state.deck.action = null;

    const flashcard = $("#flashcard");
    const deckState = $("#deck-state");
    const actions = $(".deck-actions");
    const hint = $("#deck-hint");
    const dots = $("#deck-dots");

    if (flashcard) flashcard.hidden = true;
    if (deckState) deckState.hidden = false;
    if (actions) actions.hidden = true;
    if (hint) hint.hidden = true;
    if (dots) dots.hidden = true;

    setText("#card-counter", "готово");
    setText("#deck-due-text", "сессия завершена");

    const nextDate = formatNextReview();
    setText("#deck-state-title", forgottenCount ? "Хорошая работа" : "Колода на сегодня пройдена");

    if (forgottenCount) {
      setText(
        "#deck-state-text",
        `Помню: ${remembered} · Забыл: ${forgottenCount}. Забытые слова вернутся в повторение — можно пройти их ещё раз прямо сейчас.`
      );
      const button = $("#deck-state-button");
      if (button) button.textContent = `Повторить забытые (${forgottenCount})`;
      state.deck.action = () => startDeck(forgotten);
    } else {
      setText(
        "#deck-state-text",
        `Все ${total} ${plural(total, "слово", "слова", "слов")} повторены. ${
          nextDate ? `Следующее повторение: ${nextDate}.` : "Можно повторить все слова в любое время."
        }`
      );
      const button = $("#deck-state-button");
      if (button) button.textContent = "Повторить все слова";
      state.deck.action = () => startDeck(state.data.flashcards, { all: true });
    }

    const stateButton = $("#deck-state-button");
    if (stateButton) stateButton.focus({ preventScroll: true });
  }

  function showDeckIdle() {
    state.deck.active = false;
    state.deck.queue = [];
    state.deck.index = 0;
    state.deck.forgotten = [];
    state.deck.action = null;

    const flashcard = $("#flashcard");
    const deckState = $("#deck-state");
    const actions = $(".deck-actions");
    const hint = $("#deck-hint");
    const dots = $("#deck-dots");

    if (flashcard) flashcard.hidden = true;
    if (deckState) deckState.hidden = false;
    if (actions) actions.hidden = true;
    if (hint) hint.hidden = true;
    if (dots) dots.hidden = true;

    const nextDate = formatNextReview();
    setText("#card-counter", "—");
    setText("#deck-due-text", "нет карточек к повторению");
    setText("#deck-state-title", "На сегодня всё");
    setText(
      "#deck-state-text",
      nextDate
        ? `Все карточки повторены. Следующее повторение: ${nextDate}.`
        : "Все карточки повторены. Можно вернуться к ним в любое время."
    );

    const button = $("#deck-state-button");
    if (button) button.textContent = "Повторить все слова";
    state.deck.action = () => startDeck(state.data.flashcards, { all: true });
  }

  function formatNextReview() {
    if (!state.progress) return null;
    const now = Date.now();
    const dueDates = Object.values(state.progress.cards)
      .map((entry) => (entry && Number.isFinite(entry.due) ? entry.due : null))
      .filter((due) => due && due > now + 60 * 1000);

    if (!dueDates.length) return null;
    return formatDate(Math.min(...dueDates));
  }

  function formatDate(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startTomorrow = new Date(startToday.getTime() + DAY);
    const startDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());

    if (startDate.getTime() === startToday.getTime()) return "сегодня";
    if (startDate.getTime() === startTomorrow.getTime()) return "завтра";
    return date.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
  }

  /* ---------- Base events & reset ---------- */

  function setupBaseEvents() {
    const reset = $("#reset-progress");
    if (reset) {
      reset.addEventListener("click", () => {
        if (!state.data || !state.progress) return;
        if (!window.confirm("Сбросить весь прогресс урока? Ответы квиза, словарь и расписание карточек будут удалены.")) {
          return;
        }
        resetAllProgress();
      });
    }
  }

  function resetAllProgress() {
    cancelSpeech();
    closePopover({ restoreFocus: false, silent: true });

    if (state.progress) {
      state.progress = createProgress();
      saveProgress();
    }

    renderSavedWords();
    renderQuiz();
    startDeck();
    updateCompletionUI();
    updateAsideStats();
    setRate(1, false);
    showToast("Прогресс урока сброшен");
  }

  /* ---------- Toast ---------- */

  function showToast(message) {
    const toast = $("#toast");
    if (!toast) return;

    toast.hidden = false;
    toast.textContent = message;

    window.clearTimeout(toastTimer);
    window.clearTimeout(toastHideTimer);

    requestAnimationFrame(() => toast.classList.add("is-visible"));

    toastTimer = window.setTimeout(() => {
      toast.classList.remove("is-visible");
      toastHideTimer = window.setTimeout(() => {
        toast.hidden = true;
      }, 220);
    }, 2400);
  }
})();
