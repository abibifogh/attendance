-- What a birthday says, and who hears it.
--
-- The wording was in the code, which meant the one message in this app that is
-- not about hours or money was the one message nobody here could change. A
-- property that wants to say something in its own voice - or that would rather
-- the app said nothing at all and left it to a person - had no way to.
--
-- Seeded with exactly what the code has been sending since the day it went in,
-- so turning the screen on changes nothing until somebody edits a box.

-- Whether the app wishes the person at all. On, because that is what it has
-- been doing.
INSERT OR IGNORE INTO settings (key, value) VALUES ('att_bd_wish', '1');

-- What they get. {name} is their first name, or their preferred name where
-- they have given one, and {property} is what this place calls itself.
INSERT OR IGNORE INTO settings (key, value)
VALUES ('att_bd_title', 'Happy birthday, {name}');
INSERT OR IGNORE INTO settings (key, value)
VALUES ('att_bd_line', 'Everybody at {property} hopes you have a lovely day.');

-- Whether it reaches their phone or waits in the bell for them. A birthday
-- wish that arrives three days later is not a birthday wish.
INSERT OR IGNORE INTO settings (key, value) VALUES ('att_bd_push', '1');

-- The other message, which goes to whoever runs the floor and is a prompt
-- rather than a wish. It is deliberately separate: the thing a person actually
-- remembers is a colleague saying it out loud, and an app that only sends an
-- automatic message has replaced that rather than prompted it.
INSERT OR IGNORE INTO settings (key, value) VALUES ('att_bd_prompt', '1');
INSERT OR IGNORE INTO settings (key, value)
VALUES ('att_bd_prompt_body',
        'They have been told. What they will remember is somebody saying it out loud, '
        || 'and there is a card ready to send on the Today screen.');

-- How far ahead the coming-up list looks. A card is usually made the day
-- before, and a month is long enough to plan one without the list becoming
-- everybody.
INSERT OR IGNORE INTO settings (key, value) VALUES ('att_bd_ahead', '30');
