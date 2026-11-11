// Errors the API turns into clear responses: Invalid -> 400 with the message, NotFound -> 404.
export class Invalid extends Error {}
export class NotFound extends Error {}
