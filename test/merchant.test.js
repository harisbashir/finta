import { test } from 'node:test';
import assert from 'node:assert/strict';
import { merchantKey, guessCategory } from '../server/lib/merchant.js';
import { parseCsv, detectMapping, parseAmount } from '../server/lib/csv.js';

// Statement lines in the shapes CIBC (and card issuers) export, with the category Finta should guess.
const CASES = [
  ['Electronic Funds Transfer PAY ACME PAYROLL', 'in', 'Salary'],
  ['Electronic Funds Transfer PAY WIDGET WORKS INC. CPT', 'in', 'Salary'],
  ['Electronic Funds Transfer DEPOSIT AE/EI', 'in', 'Other Income'],
  ['Electronic Funds Transfer DEPOSIT CANADA', 'in', 'Other Income'],
  ['Electronic Funds Transfer PREAUTHORIZED DEBIT NSLSC', 'out', 'Debt'],
  ['PETRO CANADA12345 OTTAWA, ON', 'out', 'Transport'],
  ['IMPARK00012345A TORONTO, ON', 'out', 'Transport'],
  ['PRECISE PARKLINK INC TORONTO, ON', 'out', 'Transport'],
  ['PARKEDIN PRECISE PARKL TORONTO, ON', 'out', 'Transport'],
  ['SQ *TARGET PARK GROUP Toronto, ON', 'out', 'Transport'],
  ['MTA*NYCT PAYGO NEW YORK, NY 2.90 USD @ 1.400000', 'out', 'Transport'],
  ['MAIN ST GAS & WASH HAMILTON, ON', 'out', 'Transport'],
  ['PART SOURCE #100 OTTAWA, ON', 'out', 'Transport'],
  ['COSTCO GAS OTTAWA, ON', 'out', 'Transport'],
  ["TIM HORTON'S #1000 OTTAWA, ON", 'out', 'Dining Out'],
  ['CHICK-FIL-A OTTAWA, ON', 'out', 'Dining Out'],
  ["CHURCH'S TEXAS CHICKEN HAMILTON, ON", 'out', 'Dining Out'],
  ['PITA PALACE HAMILTON, ON', 'out', 'Dining Out'],
  ['FIREHOUSE SUBS OTTAWA, ON', 'out', 'Dining Out'],
  ['GOLDEN WOK LONDON 12.00 GBP @ 1.800000', 'out', 'Dining Out'],
  ['HERO CERTIFIED BURGERS OTTAWA, ON', 'out', 'Dining Out'],
  ['PIZZAIOLO OTTAWA, ON', 'out', 'Dining Out'],
  ['CORNER BAKERS AND SWEET OTTAWA, ON', 'out', 'Dining Out'],
  ['00100 MACS CONV. STORE OTTAWA, ON', 'out', 'Groceries'],
  ['A.B. CONVENIENCE STORE TORONTO, ON', 'out', 'Groceries'],
  ['7-ELEVEN STORE #10000 OTTAWA, ON', 'out', 'Groceries'],
  ['HELLOFRESH Toronto, ON', 'out', 'Groceries'],
  ['EAST WEST GROCERS OTTAWA, ON', 'out', 'Groceries'],
  ['WINNERSHOMESENSE 10000 OTTAWA, ON', 'out', 'Shopping'],
  ['MOORES CLOTHING 0001 NEW MARKET, ON', 'out', 'Shopping'],
  ['COLES 100 OTTAWA, ON', 'out', 'Shopping'],
  ['CANADA COMPUTERS #1 OTTAWA, ON', 'out', 'Shopping'],
  ["LEVI'S OUTLET LONDON 50.00 GBP @ 1.800000", 'out', 'Shopping'],
  ['SPORT CLIPS MAIN ST OTTAWA, ON', 'out', 'Personal Care'],
  ['BATH AND BODY WORKS OTTAWA, ON', 'out', 'Personal Care'],
  ['Point of Sale - Interac RETAIL PURCHASE 000000000001 SUNNY NAILS', 'out', 'Personal Care'],
  ['FYIDOCTORS-OTTAWA OTTAWA, ON', 'out', 'Health'],
  ['CITY CHEMIST LONDON 10.00 GBP @ 1.800000', 'out', 'Health'],
  ['CITY LABS OTTAWA, ON', 'out', 'Health'],
  ['SP THE CPAP STORE VANCOUVER, BC', 'out', 'Health'],
  ['Branch Transaction NON-SUFFICIENT FUNDS CHARGE', 'out', 'Fees & Interest'],
];

for (const [description, direction, expected] of CASES) {
  test(`guess: ${description} → ${expected}`, () => {
    assert.equal(guessCategory(description, direction), expected);
  });
}

test('CIBC "Electronic Funds Transfer" rows key on the payee, not the channel', () => {
  assert.equal(merchantKey('Electronic Funds Transfer PAY ACME PAYROLL'), 'ACME PAYROLL');
  assert.equal(merchantKey('Electronic Funds Transfer PREAUTHORIZED DEBIT NSLSC'), 'NSLSC');
  assert.equal(merchantKey('Electronic Funds Transfer DEPOSIT AE/EI'), 'AE EI');
  assert.notEqual(merchantKey('Electronic Funds Transfer PREAUTHORIZED DEBIT PAYPAL'), merchantKey('Electronic Funds Transfer PREAUTHORIZED DEBIT NSLSC'));
});

test('one key per chain: store numbers glued to names, towns and foreign-currency tails are dropped', () => {
  assert.equal(merchantKey('PETRO CANADA12345 OTTAWA, ON'), 'PETRO CANADA');
  assert.equal(merchantKey('PETRO CANADA67890 HAMILTON, ON'), 'PETRO CANADA');
  assert.equal(merchantKey('PITA PALACE MAPLE MAPLE, ON'), 'PITA PALACE');
  assert.equal(merchantKey("LEVI'S OUTLET G1 DUBAI 100.00 AED @ .380000"), "LEVI'S OUTLET");
  assert.equal(merchantKey('ULTRAMAR CONCORD, ON'), 'ULTRAMAR');
  assert.equal(merchantKey('BURGER KING #123 TORONTO, ON'), 'BURGER KING', 'KING alone is not a town');
});

test('bill payments key on the payee', () => {
  assert.equal(merchantKey('Internet Banking INTERNET BILL PAY 000000000001 BELL CANADA BUSINESS INTE'), 'BELL CANADA BUSINESS');
});

test('a masked card-number column is not read as a balance', () => {
  assert.equal(parseAmount('4500********1234'), null);
  const rows = parseCsv([
    '2026-01-21,"WAL-MART SUPERCENTER#1000 OTTAWA, ON",12.34,,4500********1234',
    '2026-01-19,"CANADA COMPUTERS #1 OTTAWA, ON",56.78,,4500********1234',
    '2026-01-15,PAYMENT THANK YOU/PAIEMEN T MERCI,,100.00,4500********1234',
  ].join('\n'));
  const m = detectMapping(rows);
  assert.equal(m.balance, -1);
  assert.equal(m.debit, 2);
  assert.equal(m.credit, 3);
});
