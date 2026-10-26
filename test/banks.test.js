import { test } from 'node:test';
import assert from 'node:assert/strict';
import { merchantKey, guessCategory } from '../server/lib/merchant.js';

// Statement wording from Canadian banks (made-up payees and numbers): key on the payee, guess the category.
const BANKS = [
  // RBC
  ['WWW PAYMENT - 1234 ROGERS', 'out', 'ROGERS', 'Utilities'],
  ['Misc Payment INTACT INSURANCE', 'out', 'INTACT INSURANCE', 'Insurance'],
  // TD
  ['ROGERS ______ BPY', 'out', 'ROGERS', 'Utilities'],
  ['TELUS MOBILITY _F', 'out', 'TELUS MOBILITY', 'Utilities'],
  // BMO
  ['PAY BILL BELL CANADA', 'out', 'BELL CANADA', 'Utilities'],
  ['Bill Payment ENBRIDGE GAS', 'out', 'ENBRIDGE GAS', 'Utilities'],
  // Tangerine
  ['Bill Payment - TORONTO HYDRO', 'out', 'TORONTO HYDRO', 'Utilities'],
  ['Pre-Authorized Payment - TD INSURANCE', 'out', 'TD INSURANCE', 'Insurance'],
  ['EFT Withdrawal to ACME BANK', 'out', 'ACME BANK', 'Transfer'],
  // Simplii / Wealthsimple / EQ Bank
  ['Direct deposit from ACME PAYROLL', 'in', 'ACME PAYROLL', 'Salary'],
  // Desjardins / National Bank (French)
  ['Paiement facture - AccesD Internet /HYDRO-QUEBEC', 'out', 'HYDRO QUEBEC', 'Utilities'],
  ['PAIEMENT PREAUTORISE BELAIRDIRECT', 'out', 'BELAIRDIRECT', 'Insurance'],
  ['DEPOT DIRECT SALAIRE ACME', 'in', 'SALAIRE ACME', 'Salary'],
  ['Virement a 1234567 REER', 'out', null, 'Transfer'],
  ['RETRAIT GAB 1234 MONTREAL', 'out', null, null],
  ['FRAIS MENSUELS', 'out', null, 'Fees & Interest'],
  ['INTERETS SUR MARGE', 'out', null, 'Fees & Interest'],
];

const BILLERS = [
  ['SASKTEL MOBILITY', 'Utilities'], ['DISTRIBUTEL', 'Utilities'], ['START.CA INTERNET', 'Utilities'],
  ['CARRY TELECOM', 'Utilities'], ['BELL MTS', 'Utilities'], ['NEWMARKET-TAY POWER', 'Utilities'],
  ['OAKVILLE HYDRO', 'Utilities'], ['KITCHENER UTILITIES', 'Utilities'], ['NOVA SCOTIA POWER', 'Utilities'],
  ['NB POWER', 'Utilities'], ['SASKPOWER', 'Utilities'], ['SASKENERGY', 'Utilities'], ['MANITOBA HYDRO', 'Utilities'],
  ['FORTISBC', 'Utilities'], ['VERIDIAN', 'Utilities'],
  ['CAA INSURANCE', 'Insurance'], ['SQUARE ONE INSURANCE', 'Insurance'], ['EQUITABLE LIFE', 'Insurance'],
  ['IA FINANCIAL GROUP', 'Insurance'], ['INDUSTRIAL ALLIANCE', 'Insurance'], ['EMPIRE LIFE', 'Insurance'],
  ['ALLIANZ GLOBAL', 'Insurance'], ['ONTARIO BLUE CROSS', 'Insurance'], ['GREEN SHIELD CANADA', 'Insurance'],
  ['PEMBRIDGE INS', 'Insurance'], ['ICBC AUTOPLAN', 'Insurance'], ['ONLIA', 'Insurance'],
  ['407ETR BILL', 'Transport'], ['SAAQ PERMIS', 'Transport'], ['SERVICEONTARIO PLATE RENEWAL', 'Transport'],
];

for (const [description, direction, key, category] of BANKS) {
  test(`bank: ${description}`, () => {
    if (key) assert.equal(merchantKey(description), key);
    assert.equal(guessCategory(description, direction), category);
  });
}

for (const [description, category] of BILLERS) {
  test(`biller: ${description} → ${category}`, () => {
    assert.equal(guessCategory(description, 'out'), category);
  });
}
