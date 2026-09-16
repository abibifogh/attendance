import { h } from './util.js';

/**
 * The digits, typed without a keyboard.
 *
 * WHY THIS IS NOT A TEXT FIELD. A PIN box is a password input, and a password
 * input on a phone is standing in a busy road. The browser's own password
 * manager fills it whether or not the field says autocomplete="off", because
 * every engine overrides that for password fields where it holds a credential
 * for the origin. A software keyboard may add a space from predictive text or
 * hold the last character in composition until the field is blurred, which on
 * a phone happens after the button has already read the value. None of it
 * shows: the field draws dots either way, so somebody is looking at what
 * appears to be their own PIN being refused.
 *
 * Buttons that append to a string in this file cannot be autofilled, cannot be
 * composed, and cannot hold anything that is not a digit. It is also the
 * control the property already knows, and the one that works with wet hands.
 *
 * The caller composes the parts. The sign-in puts its error line between the
 * display and the keys and the lock screen puts it underneath, and a keypad
 * that insisted on one of those would have to be argued with by the other.
 */
export function pinKeypad({ onSubmit, onChange = null, max = 12 }) {
  let pin = '';
  let busy = false;

  const display = h('div.pin-display', '');
  const paint = () => { display.textContent = '•'.repeat(pin.length); };

  const press = (digit) => {
    if (pin.length >= max) return;
    pin += digit;
    paint();
    onChange?.();
  };

  const back = () => { pin = pin.slice(0, -1); paint(); onChange?.(); };

  const go = async () => {
    if (busy || !pin) return;
    busy = true;
    try { await onSubmit(pin); } finally { busy = false; }
  };

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
  const keypad = h('div.keypad',
    keys.map((k) => h('button', { type: 'button', onclick: () => press(k) }, k)),
    h('button.btn-ghost', { type: 'button', onclick: back }, '⌫'),
    h('button', { type: 'button', onclick: () => press('0') }, '0'),
    h('button.btn-primary', { type: 'button', onclick: go }, '→'),
  );

  // A laptop has a number row and people use it. On window rather than on a
  // field, because there is no field to focus.
  const onKeydown = (event) => {
    if (/^\d$/.test(event.key)) press(event.key);
    else if (event.key === 'Backspace') back();
    else if (event.key === 'Enter') go();
  };

  return {
    display,
    keypad,
    value: () => pin,
    clear: () => { pin = ''; paint(); },
    shake: () => display.animate(
      [{ transform: 'translateX(-6px)' }, { transform: 'translateX(6px)' }, { transform: 'translateX(0)' }],
      { duration: 180, iterations: 2 },
    ),
    listen: () => window.addEventListener('keydown', onKeydown),
    stopListening: () => window.removeEventListener('keydown', onKeydown),
  };
}
