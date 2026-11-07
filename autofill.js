// Grailed sell-form autofill. Runs as a bookmarklet in your normal Chrome on grailed.com/sell/new.
// Item data comes from `uv run list_grailed.py` (local server on 127.0.0.1:8765, clipboard as fallback).
(async () => {
  const API = 'http://127.0.0.1:8765';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const problems = [];
  const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();

  let d;
  try {
    d = await (await fetch(API + '/item.json')).json();
  } catch (e) {
    try { d = JSON.parse(await navigator.clipboard.readText()); }
    catch (e2) { alert('No item data. Run `uv run list_grailed.py` first.'); return; }
  }

  const setVal = (el, v) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const press = (el) => {
    const o = { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse', pointerId: 1, isPrimary: true };
    el.dispatchEvent(new PointerEvent('pointerdown', o));
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new PointerEvent('pointerup', o));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.dispatchEvent(new MouseEvent('click', o));
  };
  const key = (el, k) => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: k, bubbles: true }));
  };
  const visible = (el) => el.offsetParent !== null || el.getClientRects().length > 0;
  const findText = (els, want) => {
    const w = norm(want);
    els = els.filter(visible);
    return els.find((e) => norm(e.textContent) === w)
      || els.find((e) => norm(e.textContent).startsWith(w))
      || els.find((e) => norm(e.textContent).includes(w));
  };
  const menuItems = () => [...document.querySelectorAll('[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox],[role=option]')];
  const closeMenus = () => { if (menuItems().some(visible)) key(document.activeElement || document.body, 'Escape'); };
  const waitFor = async (fn, ms = 4000) => {
    for (let t = 0; t < ms; t += 100) { const v = fn(); if (v) return v; await sleep(100); }
    return null;
  };

  // Open the dropdown whose button text contains `trigger`, then click each option in turn.
  const pick = async (trigger, ...opts) => {
    opts = opts.filter(Boolean);
    if (!opts.length) return;
    const btn = await waitFor(() => [...document.querySelectorAll('button')]
      .find((b) => norm(b.textContent).includes(norm(trigger)) && !b.disabled));
    if (!btn) { problems.push(`${trigger}: dropdown not found/disabled`); return; }
    press(btn);
    await sleep(400);
    for (const o of opts) {
      const item = await waitFor(() => findText(menuItems(), o), 1500);
      if (!item) { problems.push(`${trigger}: no option "${o}"`); continue; }
      press(item);
      await sleep(400);
    }
    closeMenus();
    await sleep(200);
  };

  // Type into an autocomplete input and click the best suggestion.
  const autocomplete = async (sel, text, label) => {
    if (!text) return;
    const el = await waitFor(() => { const e = document.querySelector(sel); return e && !e.disabled && e; });
    if (!el) { problems.push(`${label}: input not found/disabled`); return; }
    // Remember what's on the page so we only look at suggestions that appear after typing
    // (otherwise we'd match things like the site's header menu).
    const before = new Set(document.querySelectorAll('*'));
    el.focus();
    el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    setVal(el, text);

    const w = norm(text);
    const findSuggestion = () => {
      const fresh = [...document.querySelectorAll('*')]
        .filter((e) => !before.has(e) && visible(e) && norm(e.textContent))
        .sort((a, b) => a.textContent.length - b.textContent.length); // tightest match first
      return fresh.find((e) => norm(e.textContent) === w)
        || fresh.find((e) => norm(e.textContent).startsWith(w))
        || fresh.find((e) => norm(e.textContent).includes(w));
    };
    const hit = await waitFor(findSuggestion, 4000);
    if (hit) {
      const target = hit.closest('[role=option], li, button, a, [class*="ption"], [class*="uggestion"]') || hit;
      target.scrollIntoView({ block: 'nearest' });
      press(target);
      await sleep(600);
      if (document.contains(target) && visible(target)) {
        // Click didn't close the list: try the keyboard instead.
        key(el, 'ArrowDown'); key(el, 'Enter');
        await sleep(400);
        problems.push(`${label}: check "${text}" was actually selected`);
      }
    } else {
      key(el, 'ArrowDown'); key(el, 'Enter');
      problems.push(`${label}: no "${text}" suggestion appeared, pick it manually`);
    }
    await sleep(400);
  };

  const fill = (sel, v, label) => {
    const el = document.querySelector(sel);
    if (!el) return problems.push(`${label}: field not found`);
    setVal(el, v);
  };
  const check = (sel, want) => {
    const el = document.querySelector(sel);
    if (el && el.checked !== want) el.click();
  };

  await pick('Department / Category', d.department, d.category, d.subcategory);
  await pick('Sub-category', d.subcategory);
  await autocomplete('#designer-autocomplete', d.designer, 'Designer');
  await pick('Select Size', d.size);
  fill('input[name=title]', d.title, 'Title');
  await pick('Select a Color', d.color);
  await pick('Item Condition', d.condition);
  fill('textarea[name=description]', d.description, 'Description');
  await pick('Select a Style', d.style);
  await autocomplete('#country-of-origin', d.country, 'Country');
  fill('input[name=price]', d.price, 'Price');
  check('input[name=makeOffer]', d.accept_offers);
  check('input[name="smartPricing.enabled"]', d.smart_pricing);
  await sleep(300);
  if (d.smart_pricing && d.floor_price) fill('input[name="smartPricing.minimumPrice"]', d.floor_price, 'Floor price');

  // Photos: pulled from the local server and dropped into the first photo input.
  try {
    const files = [];
    for (const url of d.photos) {
      const b = await (await fetch(API + url)).blob();
      files.push(new File([b], url.split('/').pop(), { type: b.type || 'image/jpeg' }));
    }
    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));
    const input = document.querySelector('#photo_input_0');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  } catch (e) {
    problems.push('Photos: drag them in from the Finder window');
  }

  alert(`Filled item ${d.id}: ${d.title}\n\n` +
    (problems.length ? 'Check these manually:\n- ' + problems.join('\n- ') : 'Everything filled — review, then Publish.'));
})();
