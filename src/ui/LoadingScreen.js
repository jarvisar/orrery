/**
 * Drives the loading screen that index.html paints before any module loads.
 *
 * Progress is weighted across named phases rather than counted in files, so the
 * bar moves at a roughly honest rate instead of sitting at 90% while the single
 * largest texture decodes.
 */

export class LoadingScreen {
  constructor() {
    this.root = document.getElementById('loading');
    this.bar = document.getElementById('loading-bar');
    this.status = document.getElementById('loading-status');

    /** Phase weights should sum to 1. */
    this.phases = {
      catalogue: 0.04,
      textures: 0.62,
      models: 0.12,
      scene: 0.08,
      shaders: 0.14,
    };

    this._completed = 0;
    this._current = null;
    this._currentFraction = 0;
  }

  /** Starts a phase and sets the caption shown under the bar. */
  begin(phase, message) {
    if (this._current && this._current !== phase) {
      this._completed += this.phases[this._current] ?? 0;
    }
    this._current = phase;
    this._currentFraction = 0;
    if (message) this.status.textContent = message;
    this._render();
  }

  /** Reports progress within the current phase, 0..1. */
  progress(fraction, message) {
    this._currentFraction = Math.max(0, Math.min(1, fraction));
    if (message) this.status.textContent = message;
    this._render();
  }

  _render() {
    const weight = this.phases[this._current] ?? 0;
    const value = (this._completed + weight * this._currentFraction) * 100;
    this.bar.style.width = `${Math.min(100, value).toFixed(1)}%`;
  }

  /** Fades out and removes the screen from the accessibility tree. */
  async finish() {
    this.bar.style.width = '100%';
    this.status.textContent = 'Ready';

    // One frame at 100% so the bar visibly completes instead of vanishing mid-fill.
    await new Promise((resolve) => setTimeout(resolve, 220));
    this.root.classList.add('is-done');
    await new Promise((resolve) => setTimeout(resolve, 650));
    this.root.remove();
  }

  fail(message) {
    this.status.textContent = message;
    this.bar.style.background = '#e05c5c';
  }
}
