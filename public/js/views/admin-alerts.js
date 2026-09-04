import { api } from '../api.js';
import { h, toast } from '../util.js';
import { card, table } from './components.js';

/**
 * The addresses, the gateway and the devices that notifications run on.
 *
 * Lifted out of Users & data when Notifications became a screen of its own, so
 * there is one set of these boxes and their rules rather than two that drift.
 * Nothing here decides what is sent; it is the plumbing underneath whatever
 * does.
 */

/** What each gateway calls itself, so the list is not three lowercase words. */
const GATEWAY_NAMES = { arkesel: 'Arkesel', mnotify: 'mNotify', hubtel: 'Hubtel' };

export function alertsSetup(data, reload) {
  const recipients = h('textarea', {
    rows: 3,
    placeholder: 'one address per line',
    value: data.recipients.join('\n'),
  });
  const senderName = h('input', {
    type: 'text', maxlength: 60, value: data.senderName ?? '', placeholder: 'HIVE',
  });
  const from = h('input', { type: 'text', maxlength: 200, value: data.from, placeholder: 'HIVE <hive@niceoperation.com>' });
  const replyTo = h('input', { type: 'text', maxlength: 200, value: data.replyTo ?? '', placeholder: 'someone@niceoperation.com' });
  const siteUrl = h('input', { type: 'url', maxlength: 300, value: data.siteUrl, placeholder: 'https://staff.niceoperation.com' });
  const emailEnabled = h('input', { type: 'checkbox', checked: data.emailEnabled });
  const pushEnabled = h('input', { type: 'checkbox', checked: data.pushEnabled });
  const inAppEnabled = h('input', { type: 'checkbox', checked: data.inAppEnabled });
  const noticeEmail = h('input', { type: 'checkbox', checked: data.noticeEmail });

  const smsEnabled = h('input', { type: 'checkbox', checked: data.smsEnabled });
  const smsProvider = h('select', ...(data.smsProviders ?? []).map((name) => h('option', {
    value: name, selected: name === data.smsProvider,
  }, GATEWAY_NAMES[name] ?? name)));
  const smsSender = h('input', {
    type: 'text', maxlength: 11, value: data.smsSender ?? '', placeholder: 'HIVE',
  });
  const smsReach = h('select',
    h('option', { value: 'gap', selected: data.smsReach !== 'all' },
      'Only phones that cannot show an alert'),
    h('option', { value: 'all', selected: data.smsReach === 'all' },
      'Everybody whose week changed'));
  const testNumber = h('input', { type: 'tel', maxlength: 20, placeholder: '024 123 4567' });

  const save = async () => {
    try {
      await api.updateNotifications({
        emailEnabled: emailEnabled.checked,
        pushEnabled: pushEnabled.checked,
        inAppEnabled: inAppEnabled.checked,
        noticeEmail: noticeEmail.checked,
        recipients: recipients.value.split('\n').map((s) => s.trim()).filter(Boolean),
        from: from.value.trim(),
        senderName: senderName.value.trim(),
        replyTo: replyTo.value.trim(),
        siteUrl: siteUrl.value.trim(),
        smsEnabled: smsEnabled.checked,
        smsProvider: smsProvider.value,
        smsSender: smsSender.value.trim(),
        smsReach: smsReach.value,
      });
      toast('Saved.', 'good');
      await reload();
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  const test = async () => {
    try {
      const result = await api.testNotification();
      toast(result.ok ? 'Sent — check the inbox.' : `Not sent: ${result.result?.detail ?? 'see the log below'}`,
        result.ok ? 'good' : 'bad');
      await reload();
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  const textOne = async () => {
    if (!testNumber.value.trim()) {
      toast('Type a mobile number to send the test to.', 'bad');
      return;
    }
    try {
      const result = await api.testText(testNumber.value.trim());
      toast(result.ok ? 'Sent. Check the phone.' : `Not sent: ${result.reason ?? 'see the log below'}`,
        result.ok ? 'good' : 'bad');
      await reload();
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  return h('div',
    h('div.grid.grid-2',
      card('What gets sent', { note: 'One message a morning, and only when there is something to do' },
        h('label.inline-check', inAppEnabled, h('span', 'The bell inside the app')),
        h('label.inline-check', pushEnabled, h('span', 'Phone and desktop alerts')),
        h('label.inline-check', emailEnabled, h('span', 'The morning email digest')),
        h('label.inline-check', noticeEmail,
          h('span', 'Email every notice as well as ringing the bell')),
        h('p.muted', { style: { fontSize: '.85rem' } },
          'A notice goes only to whoever it names — the person it is addressed to, or whoever holds '
          + 'the permission it is for, worked out when it is sent rather than from a list somebody '
          + 'has to keep up to date. Somebody who is not in the app all day is exactly who it is for.'),
        h('p.muted', { style: { fontSize: '.85rem', marginBottom: 0 } },
          'The morning digest is different: one message, and only when there is something to do '
          + 'about it. Only two things qualify — days that cannot be settled without somebody '
          + 'deciding, and an absence that has run long enough to stop being an oversight. An alert '
          + 'for every late arrival would be a dozen a morning, and everybody would learn to swipe '
          + 'them away.'),
      ),

      card('Email', {
        note: data.providerConfigured ? 'Provider key is set' : 'No provider key — email cannot send',
        actions: h('button.btn-sm', { onclick: test }, 'Send one now'),
      },
        h('label.field', h('span', 'Send to'), recipients),
        h('label.field', h('span', 'Sender name'), senderName,
          h('small.muted', 'The name on the mail, which is the first thing anybody reads. '
            + 'Leave it empty for HIVE')),
        h('label.field', h('span', 'From address'), from,
          h('small.muted', 'Must be at a domain your email provider has verified. A name '
            + 'written into this box wins over the one above')),
        h('label.field', h('span', 'Reply to'), replyTo,
          h('small.muted', 'Where a reply lands. Leave empty and replies go to the From address')),
        h('label.field', h('span', 'This site\'s address'), siteUrl,
          h('small.muted', 'Used for the link in the email and the alert')),
        !data.providerConfigured
          ? h('p.muted', { style: { fontSize: '.85rem', marginBottom: 0 } },
            'Set RESEND_API_KEY as a Worker secret before email will send. Everything else here can be '
            + 'filled in now.')
          : null,
      ),
    ),

    card('Text messages', {
      note: data.smsReady ? 'Ready to send' : `Not set up yet: ${(data.smsMissing ?? []).join(', ')}`,
      wide: true,
      actions: h('button.btn-sm', { onclick: textOne }, 'Send a test'),
    },
      h('p.muted', { style: { fontSize: '.85rem', marginTop: 0 } },
        'An iPhone 7 Plus stops at iOS 15, and a home-screen app needs iOS 16.4 before it can '
        + 'show an alert at all. Those phones will never buzz, however long we wait. A text '
        + 'reaches every one of them, so a published rota goes out that way as well. Numbers '
        + 'come from each person\'s record under People.'),
      h('div.grid.grid-2',
        h('div',
          h('label.inline-check', { style: { marginBottom: '.75rem' } },
            smsEnabled, h('span', 'Text staff when a rota is published')),
          h('label.field', h('span', 'Who gets a text'), smsReach,
            h('small.muted', 'Only the ones an alert cannot reach is the cheaper answer, and '
              + 'the reason this exists')),
        ),
        h('div',
          h('label.field', h('span', 'Gateway'), smsProvider,
            h('small.muted', 'Set SMS_API_KEY as a Worker secret. Hubtel needs SMS_API_SECRET '
              + 'as well')),
          h('label.field', h('span', 'Sender name'), smsSender,
            h('small.muted', 'What the message shows it is from. Eleven characters, letters and '
              + 'digits, and it has to be registered with the gateway first')),
          h('label.field', h('span', 'Send a test to'), testNumber,
            h('small.muted', 'A real message at the usual price, so somebody can prove it works '
              + 'without publishing anything')),
        ),
      )),

    h('div.btn-row', { style: { margin: '0 0 1rem' } },
      h('button.btn.btn-primary', { onclick: save }, 'Save notification settings')),

    card('Devices set up for alerts', { note: `${data.devices.length}`, wide: true },
      table([
        { key: 'label', label: 'Device', format: (v) => v || h('span.muted', 'unnamed') },
        { key: 'name', label: 'Belongs to', format: (v) => v || h('span.muted', 'the recovery sign-in') },
        { key: 'created_at', label: 'Turned on', format: (v) => (v ? v.slice(0, 16) : '—') },
        {
          key: 'actions',
          label: '',
          format: (v, r) => h('button.btn-sm', {
            onclick: async () => {
              if (!window.confirm('Stop alerting this device?')) return;
              await api.removePushDevice(r.id);
              toast('Removed.');
              await reload();
            },
          }, 'Remove'),
        },
      ], data.devices, {
        empty: 'None yet. Anybody can turn alerts on for their own device under "My account".',
      })),

  );
}

