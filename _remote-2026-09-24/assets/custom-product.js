/**
 * Custom product page: variant selection, quantity, AJAX add-to-cart, pincode checker.
 * Depends on window.CustomCart (custom-cart.js) for cart writes.
 *
 * Events dispatched on document:
 *   'product:variant-change'  detail: { sectionId, variant, quantity }
 */
(() => {
  const formatMoney = (cents, format) => {
    const value = Number(cents) / 100;
    const fmt = (n, decimals, thousands = ',', decimal = '.') => {
      const [whole, frac] = n.toFixed(decimals).split('.');
      return whole.replace(/\B(?=(\d{3})+(?!\d))/g, thousands) + (frac ? decimal + frac : '');
    };
    return (format || '{{amount}}').replace(/\{\{\s*(\w+)\s*\}\}/, (_, key) => {
      switch (key) {
        case 'amount_no_decimals': return fmt(value, 0);
        case 'amount_with_comma_separator': return fmt(value, 2, '.', ',');
        case 'amount_no_decimals_with_comma_separator': return fmt(value, 0, '.', ',');
        case 'amount_with_apostrophe_separator': return fmt(value, 2, "'", '.');
        default: return fmt(value, 2);
      }
    });
  };

  /* ---------- Quantity stepper: reusable, knows nothing about products ---------- */
  class QuantityStepper extends HTMLElement {
    connectedCallback() {
      this.input = this.querySelector('input');
      this.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-step]');
        if (!btn || btn.disabled) return;
        this.set(this.value + Number(btn.dataset.step));
      });
      this.input.addEventListener('change', () => this.set(this.value));
    }
    get value() { return parseInt(this.input.value, 10) || 1; }
    get max() { return this.input.max ? parseInt(this.input.max, 10) : Infinity; }
    set(n) {
      const clamped = Math.max(1, Math.min(n, this.max));
      if (String(clamped) !== this.input.value) {
        this.input.value = clamped;
        this.input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      this.sync();
    }
    setMax(max) {
      if (max == null) this.input.removeAttribute('max');
      else this.input.max = Math.max(1, max);
      this.set(this.value);
    }
    sync() {
      const [minus, plus] = this.querySelectorAll('[data-step]');
      minus.disabled = this.value <= 1;
      plus.disabled = this.value >= this.max;
    }
  }
  if (!customElements.get('quantity-stepper')) customElements.define('quantity-stepper', QuantityStepper);

  /* ---------- Product page ---------- */
  class ProductPage extends HTMLElement {
    connectedCallback() {
      const data = JSON.parse(this.querySelector('[data-product-json]').textContent);
      this.variants = data.variants;
      this.moneyFormat = data.moneyFormat;
      this.optionCount = data.options.length;
      this.lowStock = Number(this.dataset.lowStock) || 0;

      this.form = this.querySelector('[data-product-form]');
      this.idInput = this.querySelector('[data-variant-input]');
      this.addButton = this.querySelector('[data-add-button]');
      this.addLabel = this.querySelector('[data-add-label]');
      this.errorEl = this.querySelector('[data-form-error]');
      this.stepper = this.querySelector('quantity-stepper');
      this.picker = this.querySelector('[data-variant-picker]');

      this.variant = this.variants.find((v) => String(v.id) === this.idInput.value) || this.variants[0];

      this.picker?.addEventListener('change', (e) => this.onOptionChange(e));
      this.form.addEventListener('submit', (e) => this.onSubmit(e));
      this.querySelector('[data-quantity-input]').addEventListener('input', () => this.announce());
      this.querySelectorAll('[data-thumb]').forEach((b) =>
        b.addEventListener('click', () => this.showMedia(b.dataset.thumb))
      );

      this.render();
    }

    get selectedOptions() {
      if (!this.picker) return this.variant.options;
      return [...this.picker.querySelectorAll('fieldset')].map(
        (fs) => fs.querySelector('input:checked')?.value
      );
    }

    /** Variants matching the given values for the first `upTo` options. */
    matching(values, upTo) {
      return this.variants.filter((v) => values.slice(0, upTo).every((val, i) => v.options[i] === val));
    }

    onOptionChange(e) {
      const changedIndex = Number(e.target.closest('fieldset').dataset.optionIndex);
      const selected = this.selectedOptions;

      let next = this.variants.find((v) => v.options.every((o, i) => o === selected[i]));
      // The exact combination is missing or sold out: keep what the shopper just chose (and
      // everything before it) and move the later options to the first combination in stock.
      if (!next || !next.available) {
        const candidates = this.matching(selected, changedIndex + 1);
        next = candidates.find((v) => v.available) || next || candidates[0];
      }
      this.variant = next;
      this.render();
    }

    render() {
      const v = this.variant;
      this.idInput.value = v.id;
      this.syncPicker();
      this.renderPrice(v);
      this.renderMeta(v);
      this.renderButton(v);
      this.stepper?.setMax(v.maxQty);
      if (v.mediaId) this.showMedia(v.mediaId);
      this.hideError();

      const url = new URL(window.location.href);
      if (url.searchParams.get('variant') !== String(v.id)) {
        url.searchParams.set('variant', v.id);
        window.history.replaceState({}, '', url);
      }
      this.announce();
    }

    announce() {
      document.dispatchEvent(new CustomEvent('product:variant-change', {
        detail: { sectionId: this.dataset.section, variant: this.variant, quantity: this.stepper?.value || 1 },
      }));
    }

    /**
     * Check the inputs for the current variant, then disable values that cannot lead to an
     * in-stock variant. Option N is judged against the selections for options 0..N-1 only, so
     * the shopper can always reach any in-stock variant by working left to right. No dead ends.
     */
    syncPicker() {
      if (!this.picker) return;
      const current = this.variant.options;
      this.picker.querySelectorAll('fieldset').forEach((fs, i) => {
        const pool = this.matching(current, i);
        fs.querySelector('[data-selected-label]').textContent = current[i];
        fs.querySelectorAll('input').forEach((input) => {
          const withValue = pool.filter((v) => v.options[i] === input.value);
          const exists = withValue.length > 0;
          const inStock = withValue.some((v) => v.available);
          input.checked = input.value === current[i];
          input.disabled = !inStock;
          const label = input.nextElementSibling;
          label.classList.toggle('is-unavailable', !inStock);
          label.querySelector('[data-state-label]').textContent =
            inStock ? '' : exists ? ' – sold out' : ' – unavailable';
        });
      });
    }

    renderPrice(v) {
      const el = this.querySelector('[data-price]');
      const money = (c) => formatMoney(c, this.moneyFormat);
      const onSale = v.compareAtPrice > v.price;
      el.innerHTML = `<span class="cp-price__current${onSale ? ' is-sale' : ''}">${money(v.price)}</span>` +
        (onSale
          ? `<s class="cp-price__compare"><span class="visually-hidden">Regular price</span>${money(v.compareAtPrice)}</s>` +
            `<span class="cp-price__badge">${Math.floor(((v.compareAtPrice - v.price) * 100) / v.compareAtPrice)}% off</span>`
          : '');
    }

    renderMeta(v) {
      const sku = this.querySelector('[data-sku]');
      if (sku) {
        sku.hidden = !v.sku;
        sku.querySelector('[data-sku-value]').textContent = v.sku || '';
      }
      const stock = this.querySelector('[data-stock]');
      stock.className = 'cp__stock';
      if (!v.available) {
        stock.textContent = 'Out of stock';
        stock.classList.add('is-out');
      } else if (v.maxQty != null && this.lowStock && v.maxQty <= this.lowStock) {
        stock.textContent = `Only ${v.maxQty} left`;
        stock.classList.add('is-low');
      } else {
        stock.textContent = 'In stock';
        stock.classList.add('is-in');
      }
    }

    renderButton(v) {
      this.addButton.disabled = !v.available;
      this.addLabel.textContent = v.available ? 'Add to cart' : 'Sold out';
    }

    showMedia(id) {
      const target = this.querySelector(`[data-media-id="${id}"]`);
      if (!target) return;
      this.querySelectorAll('[data-media-id]').forEach((m) => m.classList.toggle('is-active', m === target));
      this.querySelectorAll('[data-thumb]').forEach((t) => t.classList.toggle('is-active', t.dataset.thumb === String(id)));
      // On mobile the gallery is a scroll-snap strip; bring the image into view there too.
      const list = target.parentElement;
      if (list.scrollWidth > list.clientWidth) list.scrollTo({ left: target.offsetLeft, behavior: 'smooth' });
    }

    async onSubmit(e) {
      e.preventDefault();
      const v = this.variant;
      // Belt and braces: the button is disabled for unavailable variants, but a stale page or a
      // crafted request can still get here. Shopify's /cart/add.js is the final gate (422).
      if (!v.available) return this.showError('This variant is sold out.');
      if (!window.CustomCart) return this.form.submit(); // no-JS drawer: plain form post to /cart/add

      const quantity = this.stepper.value;
      this.setLoading(true);
      try {
        await window.CustomCart.add([{ id: v.id, quantity }], { opener: this.addButton });
      } catch (err) {
        this.showError(err.message);
      } finally {
        this.setLoading(false);
      }
    }

    setLoading(on) {
      this.addButton.classList.toggle('is-loading', on);
      this.addButton.setAttribute('aria-busy', on);
      if (on) this.addButton.disabled = true;
      else this.renderButton(this.variant);
    }
    showError(msg) { this.errorEl.textContent = msg; this.errorEl.hidden = false; }
    hideError() { this.errorEl.hidden = true; this.errorEl.textContent = ''; }
  }
  if (!customElements.get('product-page')) customElements.define('product-page', ProductPage);

  /* ---------- Pincode checker ---------- */
  const PINCODE_RE = /^[1-9][0-9]{5}$/;
  const STORAGE_KEY = 'custom:pincode';
  const store = {
    get() { try { return localStorage.getItem(STORAGE_KEY) || ''; } catch { return ''; } },
    set(v) { try { localStorage.setItem(STORAGE_KEY, v); } catch { /* private mode */ } },
  };

  class PincodeChecker extends HTMLElement {
    connectedCallback() {
      this.input = this.querySelector('[data-pincode-input]');
      this.result = this.querySelector('[data-pincode-result]');
      this.button = this.querySelector('[data-pincode-submit]');
      this.zones = JSON.parse(this.querySelector('[data-zones]').textContent || '[]');
      this.api = this.dataset.api;
      this.cutoff = Number(this.dataset.cutoff) || 14;
      this.state = { variant: null, quantity: 1 };

      this.querySelector('[data-pincode-form]').addEventListener('submit', (e) => {
        e.preventDefault();
        this.check();
      });
      this.input.addEventListener('input', () => {
        this.input.value = this.input.value.replace(/\D/g, '').slice(0, 6);
        this.input.removeAttribute('aria-invalid');
      });

      document.addEventListener('product:variant-change', (e) => {
        const page = this.closest('product-page');
        if (page && page.dataset.section !== e.detail.sectionId) return;
        const variantChanged = this.state.variant?.id !== e.detail.variant.id;
        const qtyChanged = this.state.quantity !== e.detail.quantity;
        this.state = { variant: e.detail.variant, quantity: e.detail.quantity };
        // Re-check silently when the answer could change: new variant, or (API mode) new quantity.
        if (this.lastChecked && (variantChanged || (qtyChanged && this.api))) this.check();
      });

      const saved = store.get();
      if (PINCODE_RE.test(saved)) this.input.value = saved;
    }

    async check() {
      const pincode = this.input.value.trim();
      if (!PINCODE_RE.test(pincode)) {
        this.input.setAttribute('aria-invalid', 'true');
        return this.show('error', 'Please enter a valid 6-digit pincode.');
      }
      // product-page may have rendered before this element was upgraded; read its state directly.
      const page = this.closest('product-page');
      if (!this.state.variant && page?.variant) {
        this.state = { variant: page.variant, quantity: page.stepper?.value || 1 };
      }
      const variant = this.state.variant;
      if (variant && !variant.available) {
        return this.show('error', 'This option is out of stock, so it can’t be delivered right now. Try another option.');
      }

      this.lastChecked = pincode;
      this.button.disabled = true;
      this.show('loading', 'Checking…');
      try {
        const res = this.api ? await this.checkApi(pincode) : this.checkZones(pincode);
        if (res.serviceable) {
          store.set(pincode);
          this.show('success', this.successMessage(res));
          window.CustomCart?.setAttributes({ 'Delivery pincode': pincode }).catch(() => {});
        } else {
          this.show('error', res.message || `Sorry, we don’t deliver to ${pincode} yet.`, true);
        }
      } catch (err) {
        this.show('error', 'We couldn’t check this pincode right now. Please try again.');
      } finally {
        this.button.disabled = false;
      }
    }

    checkZones(pincode) {
      const prefix = Number(pincode.slice(0, 2));
      const zone = this.zones.find((z) => prefix >= z.from && prefix <= z.to);
      if (!zone) return { serviceable: false };
      return { serviceable: true, days: zone.days, warehouse: zone.warehouse, express: zone.days <= 2 };
    }

    async checkApi(pincode) {
      const v = this.state.variant;
      const res = await fetch(this.api, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ variant_id: String(v.id), quantity: this.state.quantity, pincode }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 422 || res.status === 404) return { serviceable: false, message: body.error?.message };
      if (!res.ok) throw new Error(body.error?.message || `HTTP ${res.status}`);
      if (!body.available) {
        return { serviceable: false, message: `Only limited stock is left for ${pincode}. Try a smaller quantity.` };
      }
      return {
        serviceable: true,
        days: body.fulfillment.estimated_delivery_days.max,
        warehouse: body.fulfillment.warehouse.name,
        express: body.express,
      };
    }

    successMessage({ days, express }) {
      const date = this.deliveryDate(days);
      const when = date.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
      return `${express ? 'Express delivery available. ' : ''}Delivery by <strong>${when}</strong>.`;
    }

    /** Dispatch today before the cutoff (IST), otherwise tomorrow; no dispatch or delivery on Sundays. */
    deliveryDate(days) {
      const nowIst = new Date(Date.now() + (330 + new Date().getTimezoneOffset()) * 60000);
      const d = new Date(nowIst);
      if (nowIst.getHours() >= this.cutoff) d.setDate(d.getDate() + 1);
      let left = days;
      while (left > 0) {
        d.setDate(d.getDate() + 1);
        if (d.getDay() !== 0) left--;
      }
      if (d.getDay() === 0) d.setDate(d.getDate() + 1);
      return d;
    }

    /** `plain` for any text that may come from the API, so it is never parsed as HTML. */
    show(type, message, plain = false) {
      this.result.className = `pc__result is-${type}`;
      if (plain) this.result.textContent = message;
      else this.result.innerHTML = message;
    }
  }
  if (!customElements.get('pincode-checker')) customElements.define('pincode-checker', PincodeChecker);
})();
