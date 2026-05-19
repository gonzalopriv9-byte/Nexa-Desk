import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const WELCOME_CARD_PATH = fileURLToPath(new URL('../assets/nexadesk-welcome-thanks.png', import.meta.url));
const TICKET_FLOW_CARD_PATH = fileURLToPath(new URL('../assets/nexadesk-ticket-flow.png', import.meta.url));

let cachedWelcomeCard = null;
let cachedTicketFlowCard = null;

export function createWelcomeCard() {
  cachedWelcomeCard ??= readFileSync(WELCOME_CARD_PATH);
  return cachedWelcomeCard;
}

export function createTicketFlowCard() {
  cachedTicketFlowCard ??= readFileSync(TICKET_FLOW_CARD_PATH);
  return cachedTicketFlowCard;
}
