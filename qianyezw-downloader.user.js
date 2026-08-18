// ==UserScript==
// @name         新御书屋小说下载器
// @namespace    https://github.com/Blackwindow6/qianyezw-novel-downloader
// @version      2.6.0
// @description  兼容电脑与手机扩展，分批并发续期站点会话，快速稳定下载整本 TXT
// @author       Blackwindow6
// @license      MIT
// @homepageURL  https://github.com/Blackwindow6/qianyezw-novel-downloader
// @supportURL   https://github.com/Blackwindow6/qianyezw-novel-downloader/issues
// @downloadURL  https://raw.githubusercontent.com/Blackwindow6/qianyezw-novel-downloader/main/qianyezw-downloader.user.js
// @updateURL    https://raw.githubusercontent.com/Blackwindow6/qianyezw-novel-downloader/main/qianyezw-downloader.user.js
// @match        https://www.qianyezw.com/book/*
// @match        https://www.qianyezw.com/read/*
// @run-at       document-end
// @grant        GM_download
// @grant        GM.download
// @noframes
// ==/UserScript==
(function () {
  "use strict";
  const MOBILE_USER_AGENT_RE = /Android|iPhone|iPad|iPod|Mobile/iu;
  const IS_MOBILE_DEVICE =
    MOBILE_USER_AGENT_RE.test(navigator.userAgent) ||
    window.matchMedia?.("(pointer: coarse)").matches === true;
  const CONCURRENCY_PROFILE = Object.freeze(
    IS_MOBILE_DEVICE
      ? { initial: 4, minimum: 2, maximum: 4, increaseInterval: 16 }
      : { initial: 6, minimum: 2, maximum: 6, increaseInterval: 24 },
  );
  // 站点会在约 50 个正文请求后重置会话；预留余量并在批次之间主动续期。
  const SESSION_REQUEST_BUDGET = 40;
  const CONFIG = Object.freeze({
    initialConcurrency: CONCURRENCY_PROFILE.initial,
    minConcurrency: CONCURRENCY_PROFILE.minimum,
    maxConcurrency: CONCURRENCY_PROFILE.maximum,
    concurrencyIncreaseInterval: CONCURRENCY_PROFILE.increaseInterval,
    concurrencyDecreaseFactor: 0.5,
    sessionRequestBudget: SESSION_REQUEST_BUDGET,
    requestTimeoutMs: 20_000,
    retryBaseDelayMs: 1_000,
    retryMaxDelayMs: 15_000,
    retryJitterMs: 600,
    retryBackoffFactor: 2,
    blobRevokeDelayMs: 60_000,
  });
  const BUTTON_LABEL = "↓ 下载整本 TXT";
  const CHAPTER_SEPARATOR = "─".repeat(40),
    BOOK_SEPARATOR = "═".repeat(50);
  const PARAGRAPH_END_RE = /[。！？!?….”’」』）)】》]$/u;
  const MALFORMED_PARAGRAPH_END_RE = /<\/<\/p>/giu;
  const EXTRA_PARAGRAPH_TAG_RE = /<p>\s*p?>\s*<p>/giu;
  const PARAGRAPH_TAG_ARTIFACT_RE = /^p?>$/u;
  const PAGE_POSITION_RE = /[（(]\s*(\d+)\s*\/\s*(\d+)\s*[）)]/u;
  const EMPTY_TERMINAL_PAGE_TEXT = "章节内容缺失或章节不存在！请稍后重新尝试！";
  const UI_CSS = `
        .qy-dl-widget{position:fixed;right:30px;bottom:30px;z-index:2147483647;display:grid;gap:8px;justify-items:end;font-family:system-ui;-webkit-tap-highlight-color:transparent}
        .qy-dl-status{box-sizing:border-box;display:flex;align-items:center;gap:10px;max-width:min(360px,calc(100vw - 60px));padding:10px 12px;border:1px solid #d9dedb;border-radius:6px;background:#fff;color:#36413b;box-shadow:0 4px 16px #0003;font-size:13px}.qy-dl-status[hidden]{display:none}.qy-dl-status span{min-width:0;overflow-wrap:anywhere;white-space:pre-wrap}
        .qy-dl-status button{width:36px;height:36px;flex:0 0 36px;border:0;border-radius:4px;background:#e5e9e7;color:#202421;font-size:20px;cursor:pointer;touch-action:manipulation}.qy-dl-start{min-height:44px;padding:12px 20px;border:0;border-radius:6px;background:#16794b;color:#fff;font:600 15px/1.2 system-ui;cursor:pointer;box-shadow:0 4px 16px #0003;touch-action:manipulation}.qy-dl-start:hover{background:#11633d}.qy-dl-start:disabled{background:#8b9490;cursor:not-allowed}
        @media (max-width:640px),(pointer:coarse){.qy-dl-widget{right:12px;right:calc(12px + env(safe-area-inset-right,0px));bottom:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));left:12px;left:calc(12px + env(safe-area-inset-left,0px));justify-items:stretch}.qy-dl-status{width:100%;max-width:none;font-size:14px}.qy-dl-status button{width:44px;height:44px;flex-basis:44px}.qy-dl-start{justify-self:end}}
    `;

  class HttpStatusError extends Error {
    constructor({ status, url }) {
      super(`HTTP ${status}: ${url}`);
      this.name = "HttpStatusError";
      this.status = status;
    }
  }

  class RetryablePageError extends Error {
    constructor(message) {
      super(message);
      this.name = "RetryablePageError";
    }
  }

  class ChallengePageError extends RetryablePageError {
    constructor(url) {
      super(`站点安全验证拦截了请求: ${url}`);
      this.name = "ChallengePageError";
    }
  }

  class RequestTimeoutError extends Error {
    constructor(url) {
      super(`请求超时: ${url}`);
      this.name = "TimeoutError";
    }
  }

  class FingerprintSessionRefresher {
    constructor() {
      this.pending = null;
    }

    refresh(signal) {
      if (this.pending) return this.pending;
      this.pending = renewFingerprintSession(signal).finally(() => {
        this.pending = null;
      });
      return this.pending;
    }
  }

  const SESSION_REFRESHER = new FingerprintSessionRefresher();

  class AdaptiveRequestScheduler {
    constructor({ signal, renewSession, onSessionRefresh }) {
      this.active = 0;
      this.limit = CONFIG.initialConcurrency;
      this.queue = [];
      this.successesSinceIncrease = 0;
      this.requestsSinceRefresh = 0;
      this.refreshPromise = null;
      this.signal = signal;
      this.renewSession = renewSession;
      this.onSessionRefresh = onSessionRefresh;
    }

    run({ operation, signal }) {
      if (signal.aborted) return Promise.reject(getAbortError(signal));
      return new Promise((resolve, reject) => {
        const entry = { operation, signal, resolve, reject, cancelled: false };
        const onAbort = () => {
          entry.cancelled = true;
          reject(getAbortError(signal));
          this.drain();
        };
        entry.onAbort = onAbort;
        signal.addEventListener("abort", onAbort, { once: true });
        this.queue.push(entry);
        this.drain();
      });
    }

    drain() {
      if (this.refreshPromise) return;
      this.discardCancelledEntries();
      if (!this.queue.length) return;
      if (this.requestsSinceRefresh >= CONFIG.sessionRequestBudget) {
        if (!this.active) this.startSessionRefresh();
        return;
      }
      while (
        this.active < this.limit &&
        this.queue.length &&
        this.requestsSinceRefresh < CONFIG.sessionRequestBudget
      ) {
        const entry = this.queue.shift();
        if (entry.cancelled) continue;
        entry.signal.removeEventListener("abort", entry.onAbort);
        this.start(entry);
      }
    }

    discardCancelledEntries() {
      this.queue = this.queue.filter((entry) => {
        if (!entry.cancelled) return true;
        entry.signal.removeEventListener("abort", entry.onAbort);
        return false;
      });
    }

    startSessionRefresh() {
      if (this.refreshPromise) return;
      if (this.signal.aborted) {
        this.rejectQueued(getAbortError(this.signal));
        return;
      }
      this.onSessionRefresh();
      const refresh = Promise.resolve().then(() =>
        this.renewSession(this.signal),
      );
      this.refreshPromise = refresh;
      refresh
        .then(
          () => {
            this.requestsSinceRefresh = 0;
          },
          (error) => this.rejectQueued(error),
        )
        .finally(() => {
          this.refreshPromise = null;
          this.drain();
        });
    }

    rejectQueued(error) {
      const entries = this.queue.splice(0);
      for (const entry of entries) {
        entry.signal.removeEventListener("abort", entry.onAbort);
        if (!entry.cancelled) entry.reject(error);
      }
    }

    start(entry) {
      this.active += 1;
      this.requestsSinceRefresh += 1;
      Promise.resolve()
        .then(entry.operation)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          this.active -= 1;
          this.drain();
        });
    }

    recordSuccess() {
      this.successesSinceIncrease += 1;
      if (this.successesSinceIncrease < CONFIG.concurrencyIncreaseInterval)
        return;
      this.successesSinceIncrease = 0;
      if (this.limit >= CONFIG.maxConcurrency) return;
      this.limit += 1;
      this.drain();
    }

    recordCongestion() {
      this.successesSinceIncrease = 0;
      const reduced = Math.floor(this.limit * CONFIG.concurrencyDecreaseFactor);
      this.limit = Math.max(CONFIG.minConcurrency, reduced);
    }
  }

  function resolveReadUrl(rawUrl, baseUrl) {
    const url = new URL(rawUrl, baseUrl);
    if (url.origin !== location.origin || !url.pathname.startsWith("/read/")) {
      throw new Error(`发现非法章节地址: ${url.href}`);
    }
    return url.href;
  }
  function isChallengeDocument(doc, html = "", finalUrl = "") {
    if (typeof finalUrl === "string" && finalUrl.includes("/challenge.php")) {
      return true;
    }
    const title = (
      doc.title ||
      doc.querySelector("title")?.textContent ||
      ""
    ).trim();
    if (title === "安全验证") return true;
    if (doc.querySelector('script[src*="client_fingerprint.js"]')) return true;
    return (
      html.includes("正在验证您的浏览器") && html.includes("client_fingerprint")
    );
  }
  function canExtractBookIndex(doc) {
    try {
      extractChapters(doc);
      getBookTitle(doc);
      return true;
    } catch {
      return false;
    }
  }
  function extractChapters(doc) {
    const heading = [...doc.querySelectorAll("h2")].find((node) =>
      node.textContent.includes("全部章节目录"),
    );
    if (!heading?.parentElement) throw new Error("未找到“全部章节目录”区域");
    const chapters = [];
    const seen = new Set();
    for (const link of heading.parentElement.querySelectorAll(
      'dd a[href*="/read/"]',
    )) {
      const title = link.textContent.trim();
      const url = resolveReadUrl(link.getAttribute("href"), doc.baseURI);
      if (!title || seen.has(url)) continue;
      seen.add(url);
      chapters.push(Object.freeze({ title, url }));
    }
    if (!chapters.length) throw new Error("章节目录中没有有效链接");
    return Object.freeze(chapters);
  }
  function getBookTitle(doc) {
    const title = doc.querySelector("h1")?.textContent.trim();
    if (!title) throw new Error("未找到小说标题");
    return title;
  }
  function normalizePageHtml(html) {
    return html
      .replace(MALFORMED_PARAGRAPH_END_RE, "</p>")
      .replace(EXTRA_PARAGRAPH_TAG_RE, "<p>");
  }
  function extractPagePosition(doc) {
    const heading = doc.querySelector("h1")?.textContent ?? "";
    const match = heading.match(PAGE_POSITION_RE);
    if (!match) return null;
    const current = Number(match[1]);
    const total = Number(match[2]);
    if (
      !Number.isSafeInteger(current) ||
      !Number.isSafeInteger(total) ||
      current < 1 ||
      current > total
    ) {
      throw new Error(`无效的章节分页位置: ${match[1]}/${match[2]}`);
    }
    return Object.freeze({ current, total });
  }
  function pointsToNextChapter(doc) {
    return [...doc.querySelectorAll("a")].some(
      (link) => link.textContent.trim() === "下一章",
    );
  }
  function getContentTextWithoutNavigation(doc) {
    const content = doc.getElementById("rtext");
    if (!content) return null;
    const clone = content.cloneNode(true);
    for (const noise of clone.querySelectorAll(
      'script, style, a[href^="javascript:"]',
    )) {
      noise.remove();
    }
    const text = clone.textContent.replace(/\uFEFF/g, "").trim();
    return PARAGRAPH_TAG_ARTIFACT_RE.test(text) ? "" : text;
  }
  function isConfirmedTitleOnlyPage(doc) {
    const position = extractPagePosition(doc);
    return (
      position?.current === 1 &&
      position.total === 1 &&
      pointsToNextChapter(doc) &&
      getContentTextWithoutNavigation(doc) === ""
    );
  }
  function isConfirmedEmptyTerminalPage(doc) {
    const position = extractPagePosition(doc);
    if (
      !position ||
      position.current === 1 ||
      position.current !== position.total
    )
      return false;
    const contentText = getContentTextWithoutNavigation(doc);
    const isEmptyOrMissing =
      contentText === "" || contentText?.includes(EMPTY_TERMINAL_PAGE_TEXT);
    return pointsToNextChapter(doc) && isEmptyOrMissing;
  }
  function getParagraphText(paragraph) {
    const clone = paragraph.cloneNode(true);
    for (const noise of clone.querySelectorAll(
      'script, style, a[href^="javascript:"]',
    )) {
      noise.remove();
    }
    for (const lineBreak of clone.querySelectorAll("br"))
      lineBreak.replaceWith("\n");
    return clone.textContent
      .replace(/\r\n?/g, "\n")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .trim();
  }
  function hasReadableParagraphs(doc) {
    return [...doc.querySelectorAll("#rtext p")].some((paragraph) => {
      const text = getParagraphText(paragraph);
      return Boolean(text) && !PARAGRAPH_TAG_ARTIFACT_RE.test(text);
    });
  }
  function createRequestContext(parentSignal) {
    const controller = new AbortController();
    let timedOut = false;
    const abortFromParent = () => controller.abort();
    if (parentSignal.aborted) abortFromParent();
    else
      parentSignal.addEventListener("abort", abortFromParent, { once: true });
    const timeoutId = setTimeout(() => {
      if (controller.signal.aborted) return;
      timedOut = true;
      controller.abort();
    }, CONFIG.requestTimeoutMs);
    return Object.freeze({
      signal: controller.signal,
      didTimeOut: () => timedOut,
      dispose: () => {
        clearTimeout(timeoutId);
        parentSignal.removeEventListener("abort", abortFromParent);
      },
    });
  }

  function getCookieValue(name) {
    const prefix = `${name}=`;
    const entry = document.cookie
      .split(";")
      .map((item) => item.trim())
      .find((item) => item.startsWith(prefix));
    return entry ? decodeURIComponent(entry.slice(prefix.length)) : null;
  }

  function getFingerprintCredentials() {
    const rawFingerprint = getCookieValue("client_fingerprint") ?? "";
    const parts = rawFingerprint.split("|");
    const hash = parts.length >= 5 ? parts[1] : rawFingerprint;
    const version = getCookieValue("client_fingerprint_version");
    const entropy = getCookieValue("client_fingerprint_entropy");
    if (!hash || !version || !entropy) {
      throw new ChallengePageError(location.href);
    }
    return Object.freeze({ hash, version, entropy });
  }

  async function renewFingerprintSession(signal) {
    const credentials = getFingerprintCredentials();
    const endpoint = new URL("/challenge.php", location.origin);
    endpoint.searchParams.set("redirect", location.href);
    endpoint.searchParams.set("renew", String(Date.now()));
    const response = await fetch(endpoint.href, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      },
      body: new URLSearchParams({
        action: "verify",
        fingerprint_hash: credentials.hash,
        fingerprint_version: credentials.version,
        fingerprint_entropy: credentials.entropy,
      }),
      credentials: "same-origin",
      cache: "no-store",
      signal,
    });
    if (!response.ok) {
      throw new HttpStatusError({
        status: response.status,
        url: endpoint.href,
      });
    }
    let result;
    try {
      result = await response.json();
    } catch {
      throw new ChallengePageError(endpoint.href);
    }
    if (!result?.ok) throw new ChallengePageError(endpoint.href);
    console.info("[小说下载器] 已刷新站点访问会话");
  }

  async function fetchHtmlOnce({ url, signal }) {
    const response = await fetch(url, {
      credentials: "same-origin",
      cache: "no-store",
      signal,
    });
    if (!response.ok)
      throw new HttpStatusError({ status: response.status, url });
    return Object.freeze({
      html: normalizePageHtml(await response.text()),
      finalUrl: response.url,
    });
  }

  function isNetworkTransportError(error) {
    return (
      error instanceof TypeError ||
      error?.name === "TypeError" ||
      error?.message?.includes("Failed to fetch") === true
    );
  }

  async function fetchHtmlWithRecovery({ url, signal }) {
    try {
      return await fetchHtmlOnce({ url, signal });
    } catch (error) {
      if (!isNetworkTransportError(error) || signal.aborted) throw error;
      try {
        await SESSION_REFRESHER.refresh(signal);
      } catch (refreshError) {
        console.warn(
          "[小说下载器] 访问会话刷新失败，保留原网络错误",
          refreshError,
        );
        throw error;
      }
      return fetchHtmlOnce({ url, signal });
    }
  }

  function parseChapterDocument({ page, url, allowEmptyTerminalPage }) {
    const doc = new DOMParser().parseFromString(page.html, "text/html");
    if (isChallengeDocument(doc, page.html, page.finalUrl)) {
      throw new ChallengePageError(url);
    }
    if (hasReadableParagraphs(doc) || isConfirmedTitleOnlyPage(doc)) return doc;
    if (allowEmptyTerminalPage && isConfirmedEmptyTerminalPage(doc)) return doc;
    throw new RetryablePageError(`页面缺少有效正文: ${url}`);
  }

  async function fetchDocument({
    url,
    signal,
    allowEmptyTerminalPage = false,
  }) {
    const request = createRequestContext(signal);
    try {
      let page = await fetchHtmlWithRecovery({ url, signal: request.signal });
      try {
        return parseChapterDocument({ page, url, allowEmptyTerminalPage });
      } catch (error) {
        if (!(error instanceof ChallengePageError)) throw error;
        await SESSION_REFRESHER.refresh(request.signal);
        page = await fetchHtmlOnce({ url, signal: request.signal });
        return parseChapterDocument({ page, url, allowEmptyTerminalPage });
      }
    } catch (error) {
      if (request.didTimeOut()) throw new RequestTimeoutError(url);
      throw error;
    } finally {
      request.dispose();
    }
  }
  function extractParagraphs(doc) {
    const content = doc.getElementById("rtext");
    if (!content) throw new Error("页面缺少正文容器 #rtext");
    const extracted = [...content.querySelectorAll("p")].map(getParagraphText);
    const paragraphs = extracted.filter(
      (text) => text && !PARAGRAPH_TAG_ARTIFACT_RE.test(text),
    );
    if (paragraphs.length !== extracted.filter(Boolean).length) {
      console.warn("[小说下载器] 已清理站点残留的段落标签");
    }
    if (!paragraphs.length) throw new Error("正文容器中没有有效段落");
    return paragraphs;
  }
  function extractPageParagraphs({ doc, url, allowEmptyTerminalPage }) {
    if (isConfirmedTitleOnlyPage(doc)) {
      console.warn(`[小说下载器] 目录项原页只有标题，已保留标题: ${url}`);
      return [];
    }
    if (!allowEmptyTerminalPage || !isConfirmedEmptyTerminalPage(doc)) {
      return extractParagraphs(doc);
    }
    console.warn(`[小说下载器] 已忽略站点多报的空白末页: ${url}`);
    return [];
  }
  function findNextPageUrl({ doc, currentUrl }) {
    const link = [...doc.querySelectorAll("a")].find(
      (node) => node.textContent.trim() === "下一页",
    );
    return link ? resolveReadUrl(link.getAttribute("href"), currentUrl) : null;
  }
  function extractPageCount(doc) {
    const position = extractPagePosition(doc);
    if (!position) return 1;
    if (position.current !== 1) {
      throw new Error(`章节首页分页位置不是 1: ${position.current}`);
    }
    return position.total;
  }
  function buildChapterPageUrls({ firstDocument, firstPageUrl }) {
    const pageCount = extractPageCount(firstDocument);
    const secondPageUrl = findNextPageUrl({
      doc: firstDocument,
      currentUrl: firstPageUrl,
    });
    if (pageCount === 1) {
      if (secondPageUrl) throw new Error("章节存在下一页，但标题缺少分页总数");
      return [firstPageUrl];
    }
    if (!secondPageUrl)
      throw new Error(`章节声明有 ${pageCount} 页，但缺少下一页链接`);
    const secondUrl = new URL(secondPageUrl);
    if (!/_2\.html$/u.test(secondUrl.pathname)) {
      throw new Error(`无法识别分页地址格式: ${secondPageUrl}`);
    }
    return Array.from({ length: pageCount }, (_, index) => {
      if (index === 0) return firstPageUrl;
      const pageUrl = new URL(secondUrl);
      pageUrl.pathname = secondUrl.pathname.replace(
        /_2\.html$/u,
        `_${index + 1}.html`,
      );
      return pageUrl.href;
    });
  }
  function mergePageBoundary(collected, pageParagraphs) {
    if (!pageParagraphs.length) return [...collected];
    if (!collected.length) return [...pageParagraphs];
    const lastParagraph = collected[collected.length - 1];
    if (PARAGRAPH_END_RE.test(lastParagraph))
      return [...collected, ...pageParagraphs];
    return [
      ...collected.slice(0, -1),
      lastParagraph + pageParagraphs[0],
      ...pageParagraphs.slice(1),
    ];
  }
  async function fetchChapterContent({ firstPageUrl, signal, loadDocument }) {
    const firstDocument = await loadDocument({ url: firstPageUrl, signal });
    const pageUrls = buildChapterPageUrls({ firstDocument, firstPageUrl });
    const terminalPageUrl = pageUrls[pageUrls.length - 1];
    const remainingPages = pageUrls.slice(1).map(async (url) => {
      const allowEmptyTerminalPage = url === terminalPageUrl;
      const documentPage = await loadDocument({
        url,
        signal,
        allowEmptyTerminalPage,
      });
      return extractPageParagraphs({
        doc: documentPage,
        url,
        allowEmptyTerminalPage,
      });
    });
    const pageParagraphs = [
      extractPageParagraphs({
        doc: firstDocument,
        url: firstPageUrl,
        allowEmptyTerminalPage: false,
      }),
      ...(await Promise.all(remainingPages)),
    ];
    const paragraphs = pageParagraphs.reduce(mergePageBoundary, []);
    return paragraphs.join("\n\n");
  }
  function createAbortError(message) {
    try {
      return new DOMException(message, "AbortError");
    } catch {
      const error = new Error(message);
      error.name = "AbortError";
      return error;
    }
  }
  function getAbortError(signal) {
    return signal.reason instanceof Error
      ? signal.reason
      : createAbortError("下载已取消");
  }

  function isRetryableRequestError(error) {
    if (error instanceof HttpStatusError) {
      return (
        error.status === 403 ||
        error.status === 408 ||
        error.status === 425 ||
        error.status === 429 ||
        error.status >= 500
      );
    }
    return (
      error instanceof RetryablePageError ||
      isNetworkTransportError(error) ||
      error?.name === "TimeoutError"
    );
  }

  function getRetryDelay(attempt) {
    const exponential =
      CONFIG.retryBaseDelayMs * CONFIG.retryBackoffFactor ** (attempt - 1);
    const backoff = Math.min(CONFIG.retryMaxDelayMs, exponential);
    return backoff + Math.round(Math.random() * CONFIG.retryJitterMs);
  }

  function waitForRetry({ milliseconds, signal }) {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(getAbortError(signal));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, milliseconds);
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
  async function fetchDocumentReliably({
    url,
    chapter,
    signal,
    onRetry,
    loadDocument,
    scheduler,
    allowEmptyTerminalPage,
  }) {
    let attempt = 0;
    while (true) {
      try {
        const doc = await scheduler.run({
          signal,
          operation: () =>
            loadDocument({ url, signal, allowEmptyTerminalPage }),
        });
        scheduler.recordSuccess();
        return doc;
      } catch (error) {
        if (signal.aborted) throw getAbortError(signal);
        if (!isRetryableRequestError(error)) {
          throw new Error(`${chapter.title}（${url}）: ${error.message}`, {
            cause: error,
          });
        }
        attempt += 1;
        scheduler.recordCongestion();
        const retryDelayMs = getRetryDelay(attempt);
        onRetry({
          chapter,
          url,
          attempt,
          error,
          retryDelayMs,
          concurrency: scheduler.limit,
        });
        await waitForRetry({ milliseconds: retryDelayMs, signal });
      }
    }
  }
  async function downloadChapterTask({
    chapter,
    index,
    signal,
    onRetry,
    onComplete,
    loadChapter,
    loadDocument,
    scheduler,
  }) {
    try {
      const loadPage = ({ url, signal: pageSignal, allowEmptyTerminalPage }) =>
        fetchDocumentReliably({
          url,
          chapter,
          signal: pageSignal,
          onRetry,
          loadDocument,
          scheduler,
          allowEmptyTerminalPage,
        });
      const content = await loadChapter({
        firstPageUrl: chapter.url,
        signal,
        loadDocument: loadPage,
      });
      onComplete({ chapter });
      return Object.freeze({ index, chapter, content, error: null });
    } catch (error) {
      if (signal.aborted) {
        return Object.freeze({ index, chapter, content: null, error: null });
      }
      onComplete({ chapter, error });
      return Object.freeze({ index, chapter, content: null, error });
    }
  }
  async function downloadChapters({
    chapters,
    signal,
    onProgress,
    onRetry,
    loadChapter,
    loadDocument,
    scheduler,
  }) {
    let completed = 0;
    const onComplete = ({ chapter, error }) => {
      completed += 1;
      onProgress({ completed, total: chapters.length, chapter, error });
    };
    const tasks = chapters.map((chapter, index) =>
      downloadChapterTask({
        chapter,
        index,
        signal,
        onRetry,
        onComplete,
        loadChapter,
        loadDocument,
        scheduler,
      }),
    );
    const outcomes = await Promise.all(tasks);
    const contents = Object.freeze(outcomes.map(({ content }) => content));
    const failures = Object.freeze(outcomes.filter(({ error }) => error));
    return Object.freeze({ contents, failures });
  }
  class DownloadUi {
    constructor() {
      const host = document.createElement("div");
      host.id = "qy-dl-host";
      host.style.cssText =
        "all:initial;position:fixed;inset:auto 0 0 auto;z-index:2147483647;pointer-events:none;";
      const shadow = host.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      style.textContent = UI_CSS;
      const widget = document.createElement("aside");
      widget.className = "qy-dl-widget";
      widget.style.pointerEvents = "auto";
      widget.innerHTML = `<div class="qy-dl-status" hidden><span></span><button type="button"></button></div><button type="button" class="qy-dl-start">${BUTTON_LABEL}</button>`;
      shadow.append(style, widget);
      const mount = () => {
        if (!host.isConnected) document.documentElement.appendChild(host);
      };
      mount();
      this.remountTimer = setInterval(mount, 2000);
      this.status = widget.querySelector(".qy-dl-status");
      this.info = widget.querySelector(".qy-dl-status span");
      this.action = widget.querySelector(".qy-dl-status button");
      this.button = widget.querySelector(".qy-dl-start");
      Object.freeze(this);
    }
    onStart(handler) {
      this.button.addEventListener("click", handler);
    }
    begin({ controller, total, concurrency }) {
      this.status.hidden = false;
      this.info.textContent = `正在下载 ${total} 章，使用 ${concurrency} 路并发分批获取...`;
      this.button.disabled = true;
      this.button.textContent = "准备中...";
      this.action.textContent = "×";
      this.action.title = "取消下载";
      this.action.onclick = () => {
        controller.abort(createAbortError("用户取消下载"));
        this.info.textContent = "正在取消并保存已完成章节...";
        this.action.disabled = true;
      };
    }
    progress({ completed, total, chapter, error }) {
      this.button.textContent = `${completed}/${total}`;
      this.info.textContent = `${error ? "失败" : "完成"}: ${chapter.title}`;
    }
    retry({ chapter, attempt, concurrency, retryDelayMs, error }) {
      const seconds = (retryDelayMs / 1000).toFixed(1);
      const reason =
        error?.name === "ChallengePageError"
          ? "站点安全验证拦截"
          : "连接暂时中断";
      this.info.textContent = `${reason}，已降至 ${concurrency} 路\n${seconds} 秒后第 ${attempt} 次重试: ${chapter.title}`;
    }
    sessionRefresh() {
      this.info.textContent = "当前批次已完成，正在续期访问会话...";
    }
    saving() {
      this.button.textContent = "保存中...";
      this.info.textContent = "正在生成并保存 TXT 文件...";
    }
    finish(message) {
      this.status.hidden = false;
      this.info.textContent = message;
      this.button.disabled = false;
      this.button.textContent = BUTTON_LABEL;
      this.action.disabled = false;
      this.action.textContent = "×";
      this.action.title = "关闭";
      this.action.onclick = () => {
        this.status.hidden = true;
      };
    }
  }
  function buildNovelFile({ bookTitle, chapters, download }) {
    const sections = chapters.flatMap((chapter, index) => {
      const content = download.contents[index];
      if (content === null) return [];
      const body = content ? `\n${content}` : "";
      return [`${chapter.title}\n${CHAPTER_SEPARATOR}${body}`];
    });
    const downloaded = sections.length;
    const partial = downloaded !== chapters.length;
    const header = [
      `《${bookTitle}》${partial ? "（部分）" : ""}`,
      "来源: www.qianyezw.com",
      `下载时间: ${new Date().toLocaleString()}`,
      `已下载: ${downloaded}/${chapters.length} 章`,
    ];
    if (download.failures.length) {
      header.push(
        `失败章节: ${download.failures.map(({ chapter }) => chapter.title).join("、")}`,
      );
    }
    return Object.freeze({
      downloaded,
      filename: `《${bookTitle}》${partial ? "（部分）" : ""}.txt`,
      text: `${header.join("\n")}\n${BOOK_SEPARATOR}\n\n${sections.join("\n\n")}`,
    });
  }
  function normalizeDownloadError(details) {
    if (details instanceof Error) return details;
    const message = details?.error ?? details?.details ?? String(details);
    return new Error(`扩展保存失败: ${message}`);
  }
  function getModernDownloadApi() {
    if (typeof GM !== "object" || !GM || typeof GM.download !== "function")
      return null;
    return GM.download.bind(GM);
  }
  function getLegacyDownloadApi() {
    return typeof GM_download === "function" ? GM_download : null;
  }
  function downloadWithLegacyApi({ download, url, filename }) {
    return new Promise((resolve, reject) => {
      const options = {
        url,
        name: filename,
        saveAs: false,
        onload: resolve,
        onerror: (details) => reject(normalizeDownloadError(details)),
        ontimeout: () => reject(new Error("扩展保存超时")),
      };
      try {
        const result = download(options);
        if (result?.then) result.then(resolve, reject);
      } catch (error) {
        reject(error);
      }
    });
  }
  async function tryExtensionDownload({ url, filename }) {
    const modernDownload = getModernDownloadApi();
    if (modernDownload) {
      try {
        await modernDownload({ url, name: filename, saveAs: false });
        return true;
      } catch (error) {
        console.warn("[小说下载器] GM.download 保存失败，改用其他方式", error);
      }
    }
    const legacyDownload = getLegacyDownloadApi();
    if (!legacyDownload) return false;
    try {
      await downloadWithLegacyApi({
        download: legacyDownload,
        url,
        filename,
      });
      return true;
    } catch (error) {
      console.warn("[小说下载器] GM_download 保存失败，改用浏览器下载", error);
      return false;
    }
  }
  function downloadWithBrowser({ url, filename }) {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.rel = "noopener";
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
  }
  async function saveTextFile({ filename, text }) {
    const safeName = filename.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_");
    const blob = new Blob(["\uFEFF", text], {
      type: "text/plain;charset=UTF-8",
    });
    const blobUrl = URL.createObjectURL(blob);
    try {
      const savedByExtension = await tryExtensionDownload({
        url: blobUrl,
        filename: safeName,
      });
      if (!savedByExtension) {
        downloadWithBrowser({ url: blobUrl, filename: safeName });
      }
      return savedByExtension ? "extension" : "browser";
    } finally {
      setTimeout(() => URL.revokeObjectURL(blobUrl), CONFIG.blobRevokeDelayMs);
    }
  }
  async function prepareDownload({ ui, chapters }) {
    const controller = new AbortController();
    ui.begin({
      controller,
      total: chapters.length,
      concurrency: CONFIG.initialConcurrency,
    });
    if (chapters.length > CONFIG.sessionRequestBudget) {
      ui.sessionRefresh();
      await SESSION_REFRESHER.refresh(controller.signal);
    }
    return Object.freeze({
      controller,
      scheduler: new AdaptiveRequestScheduler({
        signal: controller.signal,
        renewSession: (signal) => SESSION_REFRESHER.refresh(signal),
        onSessionRefresh: () => ui.sessionRefresh(),
      }),
    });
  }

  function runChapterDownloads({ ui, chapters, controller, scheduler }) {
    return downloadChapters({
      chapters,
      signal: controller.signal,
      scheduler,
      loadChapter: fetchChapterContent,
      loadDocument: fetchDocument,
      onProgress: (progress) => ui.progress(progress),
      onRetry: ({
        chapter,
        url,
        attempt,
        error,
        retryDelayMs,
        concurrency,
      }) => {
        console.warn(
          `[小说下载器] ${chapter.title} 第 ${attempt} 次重试，并发 ${concurrency}，页面 ${url}`,
          error,
        );
        ui.retry({ chapter, attempt, concurrency, retryDelayMs, error });
      },
    });
  }

  async function finishDownload({ ui, bookTitle, chapters, download, signal }) {
    for (const failure of download.failures) {
      console.error(
        "[小说下载器] 章节下载失败",
        failure.chapter,
        failure.error,
      );
    }
    if (download.failures.length && !signal.aborted) {
      const failedNames = download.failures
        .slice(0, 3)
        .map(({ chapter }) => chapter.title)
        .join("、");
      ui.finish(
        `下载中止：${download.failures.length} 章存在永久错误，未生成不完整文件\n${failedNames}`,
      );
      return;
    }
    const file = buildNovelFile({ bookTitle, chapters, download });
    if (!file.downloaded) {
      const message = controller.signal.aborted
        ? "下载已取消，未生成文件"
        : "下载失败：没有获取到任何章节";
      ui.finish(message);
      return;
    }
    ui.saving();
    await saveTextFile(file);
    const message = signal.aborted
      ? `已取消，已保存 ${file.downloaded}/${chapters.length} 章`
      : `已保存 ${file.downloaded}/${chapters.length} 章${download.failures.length ? `，失败 ${download.failures.length} 章` : ""}`;
    ui.finish(message);
  }

  async function executeDownload({ ui, bookTitle, chapters }) {
    const { controller, scheduler } = await prepareDownload({ ui, chapters });
    const download = await runChapterDownloads({
      ui,
      chapters,
      controller,
      scheduler,
    });
    await finishDownload({
      ui,
      bookTitle,
      chapters,
      download,
      signal: controller.signal,
    });
  }
  function parseBookDocument(page) {
    const doc = new DOMParser().parseFromString(page.html, "text/html");
    if (isChallengeDocument(doc, page.html, page.finalUrl)) {
      throw new ChallengePageError(location.href);
    }
    if (!canExtractBookIndex(doc)) {
      throw new Error("网络目录缺少有效书名或章节列表");
    }
    return doc;
  }

  async function fetchBookDocument(signal) {
    const request = createRequestContext(signal);
    try {
      const page = await fetchHtmlWithRecovery({
        url: location.href,
        signal: request.signal,
      });
      try {
        return parseBookDocument(page);
      } catch (error) {
        if (!(error instanceof ChallengePageError)) throw error;
        await SESSION_REFRESHER.refresh(request.signal);
        return parseBookDocument(
          await fetchHtmlOnce({ url: location.href, signal: request.signal }),
        );
      }
    } catch (error) {
      if (request.didTimeOut()) throw new RequestTimeoutError(location.href);
      throw error;
    } finally {
      request.dispose();
    }
  }
  async function resolveBookDocument() {
    const controller = new AbortController();
    try {
      return await fetchBookDocument(controller.signal);
    } catch (error) {
      if (error instanceof ChallengePageError) throw error;
      console.warn("[小说下载器] 网络目录失败，改用当前页面", error);
      if (!canExtractBookIndex(document)) throw error;
      return document;
    }
  }
  async function handleDownload(ui) {
    try {
      const bookDocument = await resolveBookDocument();
      const chapters = extractChapters(bookDocument);
      await executeDownload({
        ui,
        bookTitle: getBookTitle(bookDocument),
        chapters,
      });
    } catch (error) {
      console.error("[小说下载器] 下载中止", error);
      const message =
        error instanceof ChallengePageError
          ? "下载中止：站点安全验证拦截了目录请求，请刷新页面通过验证后再试"
          : `下载中止：${error.message}`;
      ui.finish(message);
    }
  }
  function init() {
    if (!/^\/book\/\d+\/?$/.test(location.pathname)) return;
    const ui = new DownloadUi();
    ui.onStart(() => handleDownload(ui));
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
