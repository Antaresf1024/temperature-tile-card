// Bouchons DOM minimaux : juste ce que la carte touche à l'import et au rendu, pour la charger
// sous Node sans navigateur ni Home Assistant.

class FakeElement {
  attachShadow() {
    const card = { classList: { toggle() {} }, addEventListener() {} };
    this.shadowRoot = { innerHTML: '', querySelector: () => card };
    return this.shadowRoot;
  }

  getBoundingClientRect() {
    return { width: 240 };
  }

  dispatchEvent(event) {
    (this.dispatched ??= []).push(event);
    return true;
  }

  appendChild(child) {
    (this.children ??= []).push(child);
    return child;
  }
}

export async function loadCard() {
  if (!globalThis.HTMLElement) {
    const registry = new Map();
    globalThis.HTMLElement = FakeElement;
    globalThis.customElements = { get: (name) => registry.get(name), define: (name, cls) => registry.set(name, cls) };
    globalThis.window = globalThis;
    globalThis.document = { createElement: (tagName) => ({ tagName, addEventListener() {} }) };
  }
  // bandeau console de la carte : inutile hors navigateur
  const info = console.info;
  console.info = () => {};
  try {
    return await import('../temperature-tile-card.js');
  } finally {
    console.info = info;
  }
}
