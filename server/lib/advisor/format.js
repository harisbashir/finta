// Plain-language money for advisor messages: 123456 → "$1,235".
export const dollars = (cents) => `$${Math.round(cents / 100).toLocaleString('en-CA')}`;
