/**
 * On-screen captions for the recording, drawn above the real app. Captions are honest labels only:
 * they never replace or fake product UI. Test agents (Flaky Lisan, Lisan-B) get a visible badge
 * wherever their name appears, because they fail on purpose (PRD 22.3).
 */
import type { BrowserContext, Page } from "@playwright/test";

const TEST_AGENTS = ["Flaky Lisan", "Lisan-B"];

/**
 * tsx compiles functions with esbuild's keepNames, which wraps them in a `__name` helper that does
 * not exist in the page. Every function this package sends to the browser needs it defined first.
 */
export async function installNameShim(context: BrowserContext): Promise<void> {
  await context.addInitScript({ content: "globalThis.__name = globalThis.__name || ((fn) => fn);" });
}

export async function installOverlay(context: BrowserContext): Promise<void> {
  await context.addInitScript((testAgents: string[]) => {
    const css = `
      #cx-bar{position:fixed;bottom:0;left:0;right:0;z-index:2147483646;display:flex;justify-content:space-between;align-items:center;
        padding:6px 16px;font:500 12px/1.4 "Inter Variable",ui-sans-serif,system-ui,sans-serif;letter-spacing:.01em;
        color:#e2e8f0;background:rgba(13,24,38,.94);pointer-events:none}
      #cx-bar b{color:#fff;font-weight:600}
      #cx-cap{position:fixed;left:50%;bottom:44px;transform:translateX(-50%) translateY(8px);z-index:2147483647;max-width:min(1040px,86vw);
        padding:14px 22px;border-radius:14px;background:rgba(13,24,38,.95);color:#f8fafc;box-shadow:0 12px 40px rgba(15,23,42,.35);
        font:500 19px/1.45 "Inter Variable",ui-sans-serif,system-ui,sans-serif;letter-spacing:-.005em;opacity:0;
        transition:opacity .35s cubic-bezier(.22,1,.36,1),transform .35s cubic-bezier(.22,1,.36,1);pointer-events:none;text-align:center}
      #cx-cap.on{opacity:1;transform:translateX(-50%) translateY(0)}
      #cx-cap small{display:block;margin-top:4px;font-size:14px;color:#94a3b8;font-weight:400}
      #cx-speed{position:fixed;top:72px;right:16px;z-index:2147483647;padding:4px 10px;border-radius:999px;background:#9a4a05;color:#fff;
        font:600 12px/1.4 ui-sans-serif,system-ui,sans-serif;display:none;pointer-events:none}
      #cx-card{position:fixed;inset:0;z-index:2147483647;display:none;place-items:center;background:#0d1826;color:#f8fafc;text-align:center;
        font-family:"Inter Variable",ui-sans-serif,system-ui,sans-serif}
      #cx-card h1{font-size:56px;font-weight:650;letter-spacing:-.03em;margin:0}
      #cx-card p{font-size:22px;color:#94a3b8;margin:18px 0 0}
      .cx-test{display:inline-block;margin-left:6px;padding:1px 6px;border-radius:6px;background:#fef3c7;color:#92400e;
        font:600 10px/1.5 ui-sans-serif,system-ui,sans-serif;letter-spacing:.02em;text-transform:uppercase;vertical-align:middle;white-space:nowrap}
    `;
    const mount = (): void => {
      if (document.getElementById("cx-bar") !== null) return;
      const style = document.createElement("style");
      style.textContent = css;
      document.head.appendChild(style);
      const bar = document.createElement("div");
      bar.id = "cx-bar";
      bar.innerHTML = "<span><b>Cardano preprod.</b> Every transaction on screen is real.</span><span>Flaky Lisan and Lisan-B are test agents that fail on purpose.</span>";
      const cap = document.createElement("div");
      cap.id = "cx-cap";
      const speed = document.createElement("div");
      speed.id = "cx-speed";
      const card = document.createElement("div");
      card.id = "cx-card";
      document.body.append(bar, cap, speed, card);
      document.body.style.paddingBottom = "30px";
      const saved = sessionStorage.getItem("cx-caption");
      if (saved !== null) {
        const { text, sub } = JSON.parse(saved) as { text: string; sub: string };
        (window as unknown as { __cxCaption: (t: string, s: string) => void }).__cxCaption(text, sub);
      }
      const label = (): void => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const hits: Text[] = [];
        for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
          const t = n.textContent ?? "";
          const parent = n.parentElement;
          if (parent === null || parent.closest("#cx-bar,#cx-cap,#cx-card,.cx-test,script,style,svg") !== null) continue;
          if (testAgents.some((a) => t.trim().startsWith(a)) && !parent.nextElementSibling?.classList.contains("cx-test")) hits.push(n as Text);
        }
        for (const n of hits) {
          const badge = document.createElement("span");
          badge.className = "cx-test";
          badge.textContent = /test agent/i.test(n.textContent ?? "") ? "fails on purpose" : "test agent, fails on purpose";
          n.parentElement?.insertAdjacentElement("afterend", badge);
        }
      };
      label();
      new MutationObserver(() => label()).observe(document.body, { childList: true, subtree: true });
    };
    const w = window as unknown as Record<string, unknown>;
    w.__cxCaption = (text: string, sub = ""): void => {
      sessionStorage.setItem("cx-caption", JSON.stringify({ text, sub }));
      const cap = document.getElementById("cx-cap");
      if (cap === null) return;
      cap.classList.remove("on");
      if (text === "") return;
      cap.innerHTML = "";
      cap.append(document.createTextNode(text));
      if (sub !== "") {
        const s = document.createElement("small");
        s.textContent = sub;
        cap.append(s);
      }
      requestAnimationFrame(() => cap.classList.add("on"));
    };
    w.__cxSpeed = (label: string): void => {
      const el = document.getElementById("cx-speed");
      if (el === null) return;
      el.textContent = label;
      el.style.display = label === "" ? "none" : "block";
    };
    w.__cxCard = (title: string, sub: string): void => {
      const card = document.getElementById("cx-card");
      if (card === null) return;
      if (title === "") {
        card.style.display = "none";
        return;
      }
      card.innerHTML = "";
      const h = document.createElement("h1");
      h.textContent = title;
      const p = document.createElement("p");
      p.textContent = sub;
      const inner = document.createElement("div");
      inner.append(h, p);
      card.append(inner);
      card.style.display = "grid";
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
    else mount();
  }, TEST_AGENTS);
}

export async function caption(page: Page, text: string, sub = ""): Promise<void> {
  console.log(`[caption] ${text}${sub === "" ? "" : ` | ${sub}`}`);
  await page.evaluate(([t, s]) => (window as unknown as { __cxCaption: (t: string, s: string) => void }).__cxCaption(t, s), [text, sub] as const).catch(() => undefined);
}

export async function speedBadge(page: Page, label: string): Promise<void> {
  await page.evaluate((l) => (window as unknown as { __cxSpeed: (l: string) => void }).__cxSpeed(l), label).catch(() => undefined);
}

export async function titleCard(page: Page, title: string, sub: string): Promise<void> {
  await page.evaluate(([t, s]) => (window as unknown as { __cxCard: (t: string, s: string) => void }).__cxCard(t, s), [title, sub] as const);
}
