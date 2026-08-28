import { api } from '../api.js';
import { deriveLoginKey, prepareNewPassword } from '../crypto.js';
import { h, mount, toast } from '../util.js';
import { canPrompt, isApple, isInstalled, onInstallChange, promptInstall } from '../install.js';
import {
  currentSubscription, disablePush, enablePush, needsHomeScreen, pushSupported, testPush,
} from '../push.js';

/**
 * Changing your own PIN or password.
 *
 * Available to everybody, because a credential that only an administrator can
 * change is a credential nobody ever changes — and a PIN that has been the same
 * since opening day is known to people who left months ago.
 *
 * An administrator has two of them. The password is the one that matters and
 * the one they must have; the PIN is a shortcut for the tablet, and it is the
 * password that authorises setting, changing or dropping it. That way an
 * administrator who has forgotten the PIN is never stuck, and four overheard
 * digits are never enough to replace themselves with four other ones.
 */
export function openAccountDialog({
  role, name, email: myEmail, isRecovery, hasPin = false, canAlert = false,
}) {
  const usesPassword = role === 'admin';
  // Only offered to people who would act on an alert. Somebody who reads the
  // month-end report has no use for a phone buzzing every morning.
  // Shown to anybody who would act on an alert, whether or not this browser
  // can carry one. A phone that cannot is exactly the phone whose owner needs
  // to be told why, and hiding the section left them with nothing to read.
  const canSeeAlerts = canAlert;
  const error = h('p.muted', { style: { minHeight: '1.2rem', fontSize: '.85rem' } });

  const current = h('input', {
    type: 'password',
    inputmode: usesPassword ? 'text' : 'numeric',
    placeholder: usesPassword ? 'Current password' : 'Current PIN',
    autocomplete: 'current-password',
  });
  const next = h('input', {
    type: 'password',
    inputmode: usesPassword ? 'text' : 'numeric',
    placeholder: usesPassword ? 'New password (10+ characters)' : 'New PIN (4 to 10 digits)',
    autocomplete: 'new-password',
  });
  const confirm = h('input', {
    type: 'password',
    inputmode: usesPassword ? 'text' : 'numeric',
    placeholder: usesPassword ? 'Repeat the new password' : 'Repeat the new PIN',
    autocomplete: 'new-password',
  });

  const save = async (event) => {
    if (!current.value || !next.value) {
      error.textContent = 'Fill in every box';
      return;
    }
    if (next.value !== confirm.value) {
      error.textContent = usesPassword
        ? 'The two new passwords do not match'
        : 'The two new PINs do not match';
      return;
    }

    if (usesPassword && next.value.length < 10) {
      error.textContent = 'The new password must be at least 10 characters';
      return;
    }
    if (usesPassword && /^\d+$/.test(next.value)) {
      error.textContent = 'A password of only digits is a PIN. Include some words or letters.';
      return;
    }

    event.target.disabled = true;
    error.textContent = 'Saving…';
    try {
      if (usesPassword) {
        // Both the current and the new password are stretched here; neither
        // reaches the server in the clear.
        const params = await api.passwordSalt(myEmail);
        const currentPasswordKey = await deriveLoginKey(current.value, params.salt, params.iterations);
        await api.changeCredentials({
          currentPasswordKey,
          ...(await prepareNewPassword(next.value)),
        });
      } else {
        await api.changeCredentials({ currentPin: current.value, newPin: next.value });
      }

      toast(usesPassword ? 'Password changed' : 'PIN changed', 'good');
      dialog.close();
    } catch (err) {
      error.textContent = err.message;
      event.target.disabled = false;
    }
  };

  /** An administrator's optional keypad PIN, authorised by the password. */
  function loginPinSection() {
    const now = h('input', { type: 'password', placeholder: 'Your password', autocomplete: 'current-password' });
    const wanted = h('input', {
      type: 'password', inputmode: 'numeric', maxlength: 10,
      placeholder: hasPin ? 'New PIN (4 to 10 digits)' : '4 to 10 digits',
      autocomplete: 'new-password',
    });
    const problem = h('p.muted', { style: { minHeight: '1.2rem', fontSize: '.85rem' } });
    let mine = hasPin;

    const keyFor = async (password) => {
      const params = await api.passwordSalt(myEmail);
      return deriveLoginKey(password, params.salt, params.iterations);
    };

    const standing = h('p.muted', { style: { fontSize: '.85rem' } });
    const paint = () => {
      standing.textContent = mine
        ? 'You have one. The keypad on the sign-in screen will take it.'
        : 'You do not have one yet. The sign-in screen will only take your email address and '
          + 'password.';
      wanted.placeholder = mine ? 'New PIN (4 to 10 digits)' : '4 to 10 digits';
      drop.style.display = mine ? '' : 'none';
      setIt.textContent = mine ? 'Change the PIN' : 'Set a PIN';
    };

    const setIt = h('button.btn-primary', { onclick: async (event) => {
      problem.textContent = '';
      if (!now.value || !wanted.value) { problem.textContent = 'Fill in both boxes'; return; }
      event.target.disabled = true;
      problem.textContent = 'Saving…';
      try {
        await api.changeCredentials({
          currentPasswordKey: await keyFor(now.value),
          newPin: wanted.value.trim(),
        });
        mine = true;
        now.value = '';
        wanted.value = '';
        problem.textContent = '';
        paint();
        toast('PIN saved. You can sign in with it now.', 'good');
      } catch (err) {
        problem.textContent = err.message;
      } finally {
        event.target.disabled = false;
      }
    } }, 'Set a PIN');

    const drop = h('button.btn-ghost.btn-sm', { onclick: async (event) => {
      problem.textContent = '';
      if (!now.value) { problem.textContent = 'Type your password to take the PIN away'; return; }
      event.target.disabled = true;
      try {
        await api.changeCredentials({ currentPasswordKey: await keyFor(now.value), removePin: true });
        mine = false;
        now.value = '';
        paint();
        toast('PIN taken away. Only your password signs you in now.', 'good');
      } catch (err) {
        problem.textContent = err.message;
      } finally {
        event.target.disabled = false;
      }
    } }, 'Take it away');

    paint();

    return h('div', { style: { marginTop: '1rem', paddingTop: '.9rem', borderTop: '1px solid var(--border)' } },
      h('div.stat-label', { style: { marginBottom: '.3rem' } }, 'A PIN for the keypad'),
      h('p.muted', { style: { fontSize: '.85rem', marginTop: 0 } },
        'A short way in for a tablet, alongside your password. Your password is what sets it, '
        + 'and the payroll asks for its own PIN either way.'),
      standing,
      h('label.field', h('span', 'Your password'), now),
      h('label.field', h('span', hasPin ? 'New PIN' : 'PIN'), wanted),
      problem,
      h('div.btn-row', { style: { justifyContent: 'flex-end' } }, drop, setIt));
  }

  const body = isRecovery
    ? h('div',
      h('div.alert.warn',
        h('span.alert-icon', '🔑'),
        h('div',
          h('div.alert-title', 'You are signed in with the emergency recovery PIN'),
          h('div.alert-detail',
            'That PIN lives on the server rather than in this app, so it cannot be changed here. '
            + 'Create a proper administrator account for yourself under Users & data, then sign in '
            + 'with that.'),
        )))
    : h('div',
      h('p.muted', { style: { fontSize: '.85rem' } },
        usesPassword
          ? 'Choose something long. It does not need to be complicated — a few unrelated words is stronger than one word with symbols in it.'
          : 'Pick a PIN only you know. Everyone needs a different one, so the day sheets show who entered them.'),
      h('label.field', h('span', usesPassword ? 'Current password' : 'Current PIN'), current),
      h('label.field', h('span', usesPassword ? 'New password' : 'New PIN'), next),
      h('label.field', h('span', 'Repeat it'), confirm),
      error,
      h('div.btn-row', { style: { justifyContent: 'flex-end' } },
        // An administrator has a second credential block under this one, so a
        // Cancel button in the middle of the dialog would be answering a
        // question nobody asked. The ✕ in the corner closes it either way.
        usesPassword ? null : h('button', { onclick: () => dialog.close() }, 'Cancel'),
        h('button.btn-primary', { onclick: save }, usesPassword ? 'Change password' : 'Change PIN'),
      ),
      usesPassword ? loginPinSection() : null);

  // What the sections below want to stop doing once this is shut. They are
  // built as arguments to the call that makes the dialog, so none of them can
  // reach it: they leave their cleanup here and it is wired up afterwards.
  const onClose = [];

  const dialog = h('dialog.app-dialog.app-dialog-narrow',
    h('div.dialog-head',
      h('h2', 'My account'),
      h('button.dialog-close', {
        'aria-label': 'Close', onclick: () => dialog.close(),
      }, '✕'),
    ),
    // No negative margin. The head above this is sticky and carries its own
    // background, so a line pulled up under it is a line with its top six
    // pixels painted over — which is what "Signed in as Michael" was.
    h('p.muted', { style: { fontSize: '.85rem' } }, `Signed in as ${name}`),
    body,
    installSection(),
    canSeeAlerts ? alertsSection() : null,
  );

  document.body.append(dialog);
  dialog.addEventListener('close', () => {
    for (const stop of onClose) stop();
    dialog.remove();
  });
  dialog.showModal();
  if (!isRecovery) setTimeout(() => current.focus(), 0);

  /**
   * Putting it on the phone.
   *
   * Here rather than as a bar across the top of the app. A banner offering to
   * install something is the thing people have learned to dismiss without
   * reading; My account is where somebody goes when they have decided they
   * want it.
   *
   * Nothing at all once it is installed — an app offering to install itself is
   * how a reader concludes the thing is confused.
   */
  function installSection() {
    if (isInstalled()) return null;

    const host = h('div', {
      style: { marginTop: '1.1rem', paddingTop: '.9rem', borderTop: '1px solid var(--border)' },
    });

    const draw = () => {
      const apple = isApple();

      mount(host,
        h('h3', { style: { fontSize: '.95rem', marginBottom: '.35rem' } }, 'Put HIVE on this device'),
        h('p.muted', { style: { fontSize: '.85rem' } },
          'It opens from the home screen like any other app — no address to type, no browser bars, '
          + 'and it starts even before the signal does.'),

        canPrompt()
          ? h('button.btn-primary', {
            onclick: async (event) => {
              event.target.disabled = true;
              const outcome = await promptInstall();
              if (outcome === 'accepted') toast('Installed. Look for HIVE on your home screen.', 'good');
              else { event.target.disabled = false; draw(); }
            },
          }, 'Install')
          : apple
            // No prompt exists on an iPhone, and the steps are the only useful
            // thing the app can offer. Naming the button by its icon because
            // Apple does not name it in words anywhere on the screen.
            ? h('div.guide-note', { style: { marginTop: 0, fontSize: '.83rem' } },
              h('strong', 'On an iPhone or iPad: '),
              'press Share — the square with the arrow out of the top — then ',
              h('strong', 'Add to Home Screen'), '. Safari is the only browser on iOS that can do it.')
            : h('p.muted', { style: { fontSize: '.83rem', marginBottom: 0 } },
              'Your browser has not offered this yet. In Chrome it is in the ⋮ menu as '
              + '"Install" or "Add to Home screen"; Firefox on a phone calls it "Install".'),
      );
    };

    draw();
    // The browser can decide the app is installable a moment after this dialog
    // opened, and a button that never appears is indistinguishable from one
    // that does not exist.
    // Kept until the dialog closes rather than wired to it here: this runs
    // while the dialog is still being built, so there is nothing yet to
    // listen on.
    onClose.push(onInstallChange(draw));
    return host;
  }

  /**
   * Alerts on this device.
   *
   * Rendered into a placeholder rather than awaited before opening, so the
   * dialog never waits on a service worker to appear.
   */
  function alertsSection() {
    const host = h('div', { style: { marginTop: '1.1rem', paddingTop: '.9rem', borderTop: '1px solid var(--border)' } });
    const status = h('p.muted', { style: { fontSize: '.85rem', minHeight: '1.2rem' } });

    const heading = () => h('h3',
      { style: { fontSize: '.95rem', marginBottom: '.35rem' } }, 'Alerts on this device');

    // Nothing this browser can do. Which browser it is decides what is worth
    // saying: an iPhone wants the Home Screen instruction, anything else wants
    // to be told plainly so nobody spends an afternoon looking for a switch.
    if (!pushSupported()) {
      mount(host,
        heading(),
        needsHomeScreen()
          ? h('div.guide-note.warn', { style: { marginTop: 0, fontSize: '.83rem' } },
            h('strong', 'Add HIVE to your Home Screen first. '),
            'Tap Share, then Add to Home Screen, and open HIVE from the icon. Apple only lets '
            + 'a site send alerts once it has been added that way, so there is no switch here '
            + 'until you have.')
          : h('p.muted', { style: { fontSize: '.85rem' } },
            'This browser cannot show alerts. Chrome, Edge, Firefox and Safari all can, on an '
            + 'up-to-date phone or computer. On an iPhone or iPad, add HIVE to the Home Screen '
            + 'and open it from there.'),
      );
      return host;
    }

    const draw = (subscribed) => {
      const busy = (button, label) => { button.disabled = true; button.textContent = label; };

      const turnOn = h('button.btn-primary', {
        onclick: async (event) => {
          busy(event.target, 'Asking…');
          try {
            await enablePush();
            toast('Alerts are on for this device', 'good');
            draw(true);
          } catch (err) {
            status.textContent = err.message;
            event.target.disabled = false;
            event.target.textContent = 'Alert me on this device';
          }
        },
      }, 'Alert me on this device');

      const turnOff = h('button', {
        onclick: async (event) => {
          busy(event.target, 'Turning off…');
          await disablePush().catch(() => {});
          toast('Alerts are off for this device');
          draw(false);
        },
      }, 'Turn off');

      const tryIt = h('button.btn-sm', {
        onclick: async (event) => {
          busy(event.target, 'Sending…');
          try {
            await testPush();
            status.textContent = 'Sent. It should appear within a few seconds.';
          } catch (err) {
            status.textContent = err.message;
          }
          event.target.disabled = false;
          event.target.textContent = 'Send a test';
        },
      }, 'Send a test');

      mount(host,
        heading(),
        h('p.muted', { style: { fontSize: '.85rem' } },
          subscribed
            ? 'This device is alerted when something needs you.'
            : 'Get a notification when your rota is published, when your shift has started and '
              + 'nothing has been recorded, and when days are waiting to be confirmed. Each device '
              + 'has to be turned on separately: a phone and a computer are two separate '
              + 'permissions.'),
        needsHomeScreen() && !subscribed
          ? h('div.guide-note.warn', { style: { marginTop: 0, fontSize: '.83rem' } },
            h('strong', 'On an iPhone or iPad: '),
            'add this site to your Home Screen first (Share → Add to Home Screen) and open it from '
            + 'there. Apple only allows alerts for sites added that way.')
          : null,
        status,
        h('div.btn-row', subscribed ? [turnOff, tryIt] : [turnOn]),
      );
    };

    currentSubscription().then((sub) => draw(Boolean(sub))).catch(() => draw(false));
    return host;
  }
}
