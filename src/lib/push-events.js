/**
 * Events the terminal posts to us, rather than events we go and fetch.
 *
 * This is the mode that needs nothing running on site. The device is configured
 * with a URL and, every time somebody taps, it makes its own outbound HTTPS
 * request and tells us. No computer in a cupboard, nothing to restart after a
 * power cut, nothing for anybody to maintain.
 *
 * What it costs is the safety net. A poller asks for an overlapping window
 * every few minutes, so anything missed is picked up next time. A push is one
 * attempt: if the internet is down at 07:03, that tap is gone. The device holds
 * its own log, so nothing is lost *on the terminal* — but nothing here will go
 * and get it. That trade is the whole reason both modes exist.
 *
 * Three shapes arrive depending on model, firmware and how the listening host
 * was configured, and all three are handled: multipart/form-data with a JSON or
 * XML part (the commonest), a bare JSON body, and a bare XML body.
 */

/**
 * Everything usable in whatever the device just posted.
 *
 * Deliberately forgiving. A terminal also pushes door-open events, tamper
 * alarms and heartbeats down the same pipe, and the correct response to all of
 * them is to shrug and return 200 — a device that gets an error back may
 * disable the listening host, which would silently stop attendance altogether.
 */
export async function readNotification(request) {
  const type = (request.headers.get('Content-Type') || '').toLowerCase();

  try {
    if (type.includes('multipart/form-data')) return await fromMultipart(request);
    if (type.includes('json')) return flatten(await request.json());

    // Everything else, including the XML the device sends when its parameter
    // format is left at the default.
    const text = await request.text();
    if (!text.trim()) return [];
    if (text.trim().startsWith('{')) return flatten(JSON.parse(text));
    return fromXml(text);
  } catch {
    // A body we cannot read is not an error worth reporting to a wall-mounted
    // device that has no way to act on it.
    return [];
  }
}

/**
 * The multipart case.
 *
 * The device splits its POST into parts — the event, and sometimes a JPEG of
 * the face it just recognised. The picture is ignored: this system records that
 * somebody was at work, and keeping photographs of staff arriving is a
 * different thing to be doing, with different obligations attached.
 */
async function fromMultipart(request) {
  const form = await request.formData();
  const out = [];

  for (const value of form.values()) {
    if (typeof value !== 'string') continue;
    const text = value.trim();
    if (!text) continue;

    if (text.startsWith('{')) {
      try {
        out.push(...flatten(JSON.parse(text)));
      } catch { /* not this part */ }
    } else if (text.startsWith('<')) {
      out.push(...fromXml(text));
    }
  }

  return out;
}

/**
 * Turn the notification envelope into the flat events the ingest already
 * understands.
 *
 * The push payload names things differently from the one the poller reads —
 * `majorEventType` where the search API says `major`, the timestamp on the
 * envelope rather than the event, the whole thing nested a level down. Rather
 * than teach the ingest two vocabularies, it is translated here into the one it
 * already speaks.
 */
export function flatten(payload) {
  if (!payload || typeof payload !== 'object') return [];

  // Some firmware batches several events into one post.
  if (Array.isArray(payload)) return payload.flatMap(flatten);
  if (Array.isArray(payload.EventNotificationAlertList)) {
    return payload.EventNotificationAlertList.flatMap(flatten);
  }

  const envelope = payload.EventNotificationAlert ?? payload;
  const inner = envelope.AccessControllerEvent
    ?? envelope.accessControllerEvent
    ?? envelope.AcsEvent
    ?? null;

  // A door-held-open alarm or a heartbeat has no person attached to it.
  if (!inner) return [];
  const events = Array.isArray(inner) ? inner : [inner];

  return events.map((event) => ({
    // The envelope carries the clock; the event carries the person.
    time: envelope.dateTime ?? envelope.time ?? event.time ?? null,
    employeeNoString: event.employeeNoString ?? event.employeeNo ?? null,
    name: event.name ?? null,
    attendanceStatus: event.attendanceStatus ?? null,
    serialNo: event.serialNo ?? null,
    major: event.majorEventType ?? event.major ?? null,
    minor: event.subEventType ?? event.minor ?? null,
    doorNo: event.doorNo ?? envelope.channelID ?? null,
    currentVerifyMode: event.currentVerifyMode ?? null,
    // Kept so a device sending under the wrong serial can be spotted.
    deviceSerial: envelope.deviceID ?? envelope.macAddress ?? null,
  })).filter((event) => event.employeeNoString && event.time);
}

/**
 * The XML case, by tag extraction rather than a parser.
 *
 * Workers have no DOM, and pulling in an XML parser to read eight known fields
 * from a document this system did not design would be a dependency to maintain
 * forever. The shape is flat and the tags are unambiguous, so a targeted
 * extraction is both smaller and easier to reason about — and anything it fails
 * to recognise falls out as "not an attendance event", which is the same answer
 * a parser would give.
 */
export function fromXml(text) {
  const blocks = [...text.matchAll(/<AccessControllerEvent[^>]*>([\s\S]*?)<\/AccessControllerEvent>/gi)];
  if (!blocks.length) return [];

  const envelopeTime = tag(text, 'dateTime');

  return blocks.map((block) => {
    const body = block[1];
    return {
      time: tag(body, 'time') ?? envelopeTime,
      employeeNoString: tag(body, 'employeeNoString') ?? tag(body, 'employeeNo'),
      name: tag(body, 'name'),
      attendanceStatus: tag(body, 'attendanceStatus'),
      serialNo: tag(body, 'serialNo'),
      major: tag(body, 'majorEventType'),
      minor: tag(body, 'subEventType'),
      doorNo: tag(body, 'doorNo'),
      currentVerifyMode: tag(body, 'currentVerifyMode'),
      deviceSerial: tag(text, 'deviceID') ?? tag(text, 'macAddress'),
    };
  }).filter((event) => event.employeeNoString && event.time);
}

function tag(text, name) {
  const match = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(text);
  if (!match) return null;
  const value = match[1].trim();
  return value === '' ? null : decode(value);
}

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
};

function decode(value) {
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (m) => ENTITIES[m]);
}

/**
 * The settings to type into the terminal's own web page.
 *
 * Generated rather than written down in the documentation, because the token is
 * per-device and the host depends on where this is deployed. Somebody copying
 * these from a screen that knows both is far less likely to end up with a
 * terminal quietly posting to the wrong place.
 */
export function listeningHostSettings({ siteUrl, token }) {
  const url = new URL(siteUrl || 'https://staff.niceoperation.com');
  return {
    url: `${url.origin}/api/att/push/${token}`,
    protocolType: url.protocol === 'https:' ? 'HTTPS' : 'HTTP',
    addressingFormatType: 'hostname',
    hostName: url.hostname,
    portNo: url.protocol === 'https:' ? 443 : 80,
    urlPath: `/api/att/push/${token}`,
    parameterFormatType: 'JSON',
    httpAuthenticationMethod: 'none',
  };
}
