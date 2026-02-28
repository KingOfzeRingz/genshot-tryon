/**
 * GenShot TryOn - Overlay Styles
 *
 * CSS string constant injected into the Shadow DOM of the embedded
 * Try-On button and overlay modal. Derived from the popup.css design
 * language (colors, radii, typography).
 */

// eslint-disable-next-line no-var
var GENSHOT_OVERLAY_CSS = `
/* ============================
   Reset inside shadow root
   ============================ */
:host {
  all: initial;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
    "Helvetica Neue", Arial, sans-serif;
  font-size: 14px;
  line-height: 1.5;
  color: #2D3748;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

*, *::before, *::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

/* ============================
   Floating Action Button (FAB)
   ============================ */
.gs-fab {
  position: fixed;
  bottom: 24px;
  right: 24px;
  z-index: 2147483646;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 20px;
  border: none;
  border-radius: 50px;
  background: #6C5CE7;
  color: #FFFFFF;
  font-family: inherit;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: 0 4px 16px rgba(108, 92, 231, 0.4),
              0 2px 4px rgba(0, 0, 0, 0.1);
  transition: background 0.2s ease, transform 0.15s ease, box-shadow 0.2s ease;
  user-select: none;
}

.gs-fab:hover {
  background: #5B4BD5;
  transform: translateY(-2px);
  box-shadow: 0 6px 20px rgba(108, 92, 231, 0.5),
              0 3px 6px rgba(0, 0, 0, 0.12);
}

.gs-fab:active {
  transform: translateY(0) scale(0.97);
}

.gs-fab-icon {
  width: 20px;
  height: 20px;
  flex-shrink: 0;
}

.gs-fab.gs-hidden {
  display: none;
}

/* ============================
   Backdrop Overlay
   ============================ */
.gs-backdrop {
  position: fixed;
  inset: 0;
  z-index: 2147483646;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(2px);
  opacity: 0;
  transition: opacity 0.25s ease;
  pointer-events: none;
}

.gs-backdrop.gs-visible {
  opacity: 1;
  pointer-events: auto;
}

/* ============================
   Modal
   ============================ */
.gs-modal {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%) scale(0.95);
  z-index: 2147483647;
  width: 380px;
  max-height: 90vh;
  overflow-y: auto;
  background: #FFFFFF;
  border-radius: 16px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.2),
              0 4px 12px rgba(0, 0, 0, 0.08);
  opacity: 0;
  transition: opacity 0.25s ease, transform 0.25s ease;
  pointer-events: none;
}

.gs-modal.gs-visible {
  opacity: 1;
  transform: translate(-50%, -50%) scale(1);
  pointer-events: auto;
}

/* ---- Modal Header ---- */
.gs-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid #EDF2F7;
  background: #FAFBFC;
  border-radius: 16px 16px 0 0;
}

.gs-modal-logo {
  display: flex;
  align-items: center;
  gap: 10px;
}

.gs-modal-logo-icon {
  width: 24px;
  height: 24px;
  flex-shrink: 0;
}

.gs-modal-logo-text {
  font-size: 16px;
  font-weight: 700;
  color: #2D3748;
  letter-spacing: -0.02em;
}

.gs-modal-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: #A0AEC0;
  font-size: 20px;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}

.gs-modal-close:hover {
  background: #EDF2F7;
  color: #4A5568;
}

/* ---- Modal Body ---- */
.gs-modal-body {
  padding: 20px;
}

/* ============================
   Product Card (in modal)
   ============================ */
.gs-product-card {
  display: flex;
  gap: 14px;
  padding: 14px;
  background: #F7FAFC;
  border: 1px solid #EDF2F7;
  border-radius: 12px;
  margin-bottom: 16px;
}

.gs-product-img-wrap {
  flex-shrink: 0;
  width: 80px;
  height: 100px;
  border-radius: 8px;
  overflow: hidden;
  background: #EDF2F7;
}

.gs-product-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.gs-product-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.gs-product-brand {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #6C5CE7;
}

.gs-product-name {
  font-size: 14px;
  font-weight: 600;
  color: #2D3748;
  line-height: 1.3;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.gs-product-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 2px;
}

.gs-product-price {
  font-size: 15px;
  font-weight: 700;
  color: #2D3748;
}

.gs-product-color {
  font-size: 12px;
  color: #A0AEC0;
  padding-left: 8px;
  border-left: 1px solid #E2E8F0;
}

/* ============================
   Buttons
   ============================ */
.gs-btn-primary {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  padding: 12px 20px;
  border: none;
  border-radius: 10px;
  background: #6C5CE7;
  color: #FFFFFF;
  font-family: inherit;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.2s ease, transform 0.1s ease;
}

.gs-btn-primary:hover {
  background: #5B4BD5;
}

.gs-btn-primary:active {
  transform: scale(0.98);
}

.gs-btn-primary:disabled {
  background: #B8B0E8;
  cursor: not-allowed;
  transform: none;
}

.gs-btn-secondary {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 8px 20px;
  border: 1px solid #E2E8F0;
  border-radius: 8px;
  background: #FFFFFF;
  color: #4A5568;
  font-family: inherit;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.2s ease, border-color 0.2s ease;
}

.gs-btn-secondary:hover {
  background: #F7FAFC;
  border-color: #CBD5E0;
}

/* ============================
   Loading / Spinner
   ============================ */
.gs-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 0;
  gap: 16px;
}

.gs-spinner {
  width: 32px;
  height: 32px;
  border: 3px solid #EDF2F7;
  border-top-color: #6C5CE7;
  border-radius: 50%;
  animation: gs-spin 0.8s linear infinite;
}

@keyframes gs-spin {
  to { transform: rotate(360deg); }
}

.gs-loading-text {
  font-size: 13px;
  color: #A0AEC0;
  font-weight: 500;
}

/* ============================
   QR Code Section
   ============================ */
.gs-qr-section {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px 0;
  gap: 16px;
}

.gs-qr-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  background: #E6FFFA;
  border: 1px solid #B2F5EA;
  border-radius: 20px;
  font-size: 12px;
  font-weight: 600;
  color: #234E52;
}

.gs-qr-canvas {
  width: 200px;
  height: 200px;
  border: 1px solid #EDF2F7;
  border-radius: 12px;
  padding: 12px;
  background: #FFFFFF;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
}

.gs-qr-instruction {
  font-size: 13px;
  color: #718096;
  text-align: center;
  line-height: 1.6;
}

.gs-qr-instruction strong {
  color: #6C5CE7;
  font-weight: 600;
}

/* ============================
   Error State
   ============================ */
.gs-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 24px 0;
  gap: 12px;
  text-align: center;
}

.gs-error-icon {
  font-size: 32px;
  opacity: 0.8;
}

.gs-error-message {
  font-size: 13px;
  color: #E53E3E;
  max-width: 280px;
  line-height: 1.5;
}

/* ============================
   State visibility helper
   ============================ */
.gs-state {
  display: none;
}

.gs-state.gs-active {
  display: block;
}
`;
