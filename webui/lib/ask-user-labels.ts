/**
 * Names and the sentinel label shared by every `ask_user` host.
 *
 * The chat extension, the task runner, and the browser board all need the same
 * constant. It lives in its own module so client code can import the label
 * without pulling the Pi SDK into the browser bundle.
 */

export const ASK_USER_TOOL_NAME = 'ask_user';
export const ASK_USER_EXTENSION_NAME = 'pie-ask-user';

/** Appended to the offered options; selecting it opens the text field instead of answering. */
export const ASK_USER_OTHER_LABEL = 'Write my own answer…';
