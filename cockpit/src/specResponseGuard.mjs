/** A response may update the editor only for the ticket and request that started it. */
export function isCurrentSpecResponse(ticketId, activeTicketId, requestGeneration, activeGeneration) {
  return ticketId === activeTicketId && requestGeneration === activeGeneration;
}

/** A completed write only describes the text that was sent with that write. */
export function saveStateForEdits(savedEditGeneration, currentEditGeneration) {
  return savedEditGeneration === currentEditGeneration ? "saved" : "idle";
}
