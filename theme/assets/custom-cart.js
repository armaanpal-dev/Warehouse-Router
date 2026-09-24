/**
 * AJAX cart: a small client for Shopify's Cart API plus the drawer UI.
 *
 * - Every write goes through one promise queue, so rapid clicks can never interleave and leave the
 *   drawer showing an older cart than the server has.
 * - Line changes are keyed by the line item `key`, never the variant id: two lines can share a
 *   variant (different properties), and change.js keyed by variant id would hit both.
 * - The drawer HTML comes back with each write via the Section Rendering API, so Liquid is the only
 *   place cart markup exists.
 *
 * Public API: window.CustomCart.add(items, { opener }), .change(key, qty), .setAttributes(obj),
 *             .refresh(), .open(opener), .close()
 */
(() => {
  const SECTIONS = ['custom-cart-drawer', 'cart-icon-bubble'];
  const root = () => (window.Shopify?.routes?.root || '/');

  class CartError extends Error {
    constructor(message, status) { super(message); this.status = status; }
  }

  class CartDrawer extends HTMLElement {
    connectedCallback() {
      this.panel = this.querySelector('[role="dialog"]');
      this.status = this.querySelector('[data-cart-status]');
      this.queue = Promise.resolve();
      this.timers = new Map();

      this.addEventListener('click', (e) => this.onClick(e));
      this.addEventListener('change', (e) => {
        if (e.target.matches('[data-qty-input]')) this.scheduleChange(e.target, 0);
      });
      // On document, not the drawer: Escape must work even before focus has moved into the panel.
      document.addEventListener('keydown', (e) => this.onKeydown(e));

      // Header cart icon opens the drawer instead of navigating (the link still works without JS).
      document.addEventListener('click', (e) => {
        const icon = e.target.closest('#cart-icon-bubble');
        if (!icon || e.metaKey || e.ctrlKey || e.shiftKey) return;
        e.preventDefault();
        this.open(icon);
      });
      // Coming back via the back button restores a cached page with a possibly stale cart.
      window.addEventListener('pageshow', (e) => { if (e.persisted) this.refresh(); });
      document.addEventListener('cart:refresh', () => this.refresh());
    }

    /* ---------- Cart API ---------- */

    enqueue(task) {
      const run = this.queue.then(task, task);
      this.queue = run.catch(() => {}); // a failed write must not block the ones after it
      return run;
    }

    async post(path, payload) {
      const res = await fetch(`${root()}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ ...payload, sections: SECTIONS, sections_url: window.location.pathname }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.status) {
        // 422 = not enough stock / sold out / invalid variant. Shopify puts the reason in description.
        throw new CartError(body.description || body.message || 'Something went wrong. Please try again.', res.status);
      }
      return body;
    }

    add(items, { opener } = {}) {
      return this.enqueue(async () => {
        const body = await this.post('cart/add.js', { items });
        this.render(body.sections);
        this.open(opener);
        this.say('Added to cart.');
        document.dispatchEvent(new CustomEvent('cart:updated', { detail: { source: 'add', items: body.items } }));
        return body;
      });
    }

    change(key, quantity) {
      return this.enqueue(async () => {
        const line = this.line(key);
        line?.classList.add('is-updating');
        try {
          const body = await this.post('cart/change.js', { id: key, quantity });
          this.render(body.sections);
          this.say(quantity === 0 ? 'Item removed from cart.' : 'Cart updated.');
          document.dispatchEvent(new CustomEvent('cart:updated', { detail: { source: 'change', cart: body } }));
          return body;
        } catch (err) {
          // Re-sync to the real cart (the input may show an optimistic value), then explain.
          // Unqueued fetch: we are already inside a queued task, so refresh() would wait on itself.
          await this.fetchSections().catch(() => {});
          this.lineError(key, err.message);
          throw err;
        }
      });
    }

    setAttributes(attributes) {
      return this.enqueue(() => this.post('cart/update.js', { attributes }));
    }

    refresh() {
      return this.enqueue(() => this.fetchSections());
    }

    async fetchSections() {
      const res = await fetch(`${window.location.pathname}?sections=${SECTIONS.join(',')}`);
      if (res.ok) this.render(await res.json());
    }

    /* ---------- Rendering ---------- */

    render(sections) {
      if (!sections) return;
      const html = sections['custom-cart-drawer'];
      if (html) {
        const next = new DOMParser().parseFromString(html, 'text/html').querySelector('[data-cart-render]');
        const current = this.querySelector('[data-cart-render]');
        if (next && current) {
          const focusKey = document.activeElement?.closest('[data-focus-key]')?.dataset.focusKey;
          current.innerHTML = next.innerHTML;
          this.reapplyPending();
          // Keep keyboard users where they were (e.g. still on the + button after it re-rendered).
          if (focusKey && this.classList.contains('is-open')) {
            (this.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`) || this.panel).focus();
          }
        }
      }
      const bubble = document.getElementById('cart-icon-bubble');
      const bubbleHtml = sections['cart-icon-bubble'];
      if (bubble && bubbleHtml) {
        const doc = new DOMParser().parseFromString(bubbleHtml, 'text/html');
        bubble.innerHTML = (doc.querySelector('.shopify-section') || doc.body).innerHTML;
      }
    }

    line(key) { return this.querySelector(`[data-line-key="${CSS.escape(key)}"]`); }

    lineError(key, message) {
      const el = this.line(key)?.querySelector('[data-line-error]');
      if (el) { el.textContent = message; el.hidden = false; }
      else this.say(message);
    }

    say(message) {
      this.status.textContent = '';
      requestAnimationFrame(() => { this.status.textContent = message; });
    }

    /* ---------- Interaction ---------- */

    onClick(e) {
      if (e.target.closest('[data-cart-close]')) return this.close();

      const lineEl = e.target.closest('[data-line-key]');
      if (!lineEl) return;
      const key = lineEl.dataset.lineKey;

      if (e.target.closest('[data-remove]')) {
        this.cancelScheduled(key);
        this.change(key, 0).catch(() => {});
        return;
      }
      const step = e.target.closest('[data-qty-step]');
      if (step && !step.disabled) {
        const input = lineEl.querySelector('[data-qty-input]');
        const max = input.max ? Number(input.max) : Infinity;
        const next = Math.min(Math.max(0, (Number(input.value) || 0) + Number(step.dataset.qtyStep)), max);
        input.value = next; // optimistic; the server response replaces it
        this.scheduleChange(input, 350);
      }
    }

    /** Debounce per line, so five quick "+" clicks become one request for the final quantity. */
    scheduleChange(input, delay) {
      const key = input.closest('[data-line-key]').dataset.lineKey;
      // Capture the quantity now: a response for an earlier write may re-render this input before
      // the timer fires, and reading it then would silently drop the shopper's latest click.
      const qty = Math.max(0, parseInt(input.value, 10) || 0);
      this.cancelScheduled(key);
      const timer = setTimeout(() => {
        this.timers.delete(key);
        this.change(key, qty).catch(() => {});
      }, delay);
      this.timers.set(key, { timer, qty });
    }

    cancelScheduled(key) {
      clearTimeout(this.timers.get(key)?.timer);
      this.timers.delete(key);
    }

    /** After a re-render, show still-pending quantities rather than the server's older value. */
    reapplyPending() {
      this.timers.forEach(({ qty }, key) => {
        const input = this.line(key)?.querySelector('[data-qty-input]');
        if (input) input.value = qty;
      });
    }

    open(opener) {
      this.opener = opener || document.activeElement;
      this.removeAttribute('inert');
      this.classList.add('is-open');
      document.documentElement.classList.add('cd-lock');
      requestAnimationFrame(() => (this.querySelector('[data-cart-close]') || this.panel).focus());
    }

    close() {
      this.classList.remove('is-open');
      this.setAttribute('inert', '');
      document.documentElement.classList.remove('cd-lock');
      this.opener?.focus?.();
    }

    onKeydown(e) {
      if (!this.classList.contains('is-open')) return;
      if (e.key === 'Escape') return this.close();
      if (e.key !== 'Tab') return;
      const focusables = [...this.panel.querySelectorAll('a[href], button:not([disabled]), input:not([disabled])')]
        .filter((el) => el.offsetParent !== null);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }

  if (!customElements.get('cart-drawer-custom')) customElements.define('cart-drawer-custom', CartDrawer);

  const drawer = document.querySelector('cart-drawer-custom');
  if (drawer) {
    window.CustomCart = {
      add: (items, opts) => drawer.add(items, opts),
      change: (key, qty) => drawer.change(key, qty),
      setAttributes: (attrs) => drawer.setAttributes(attrs),
      refresh: () => drawer.refresh(),
      open: (opener) => drawer.open(opener),
      close: () => drawer.close(),
    };
  }
})();
