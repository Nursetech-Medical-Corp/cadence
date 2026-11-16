// How SOP flows are drawn on whiteboards, for people and AI agents alike. A workspace can replace these with its own
// (Whiteboards page, Drawing rules), for example to follow a book or company standard; board_conventions returns
// whichever applies.
export const DEFAULT_DRAWING_RULES = `Drawing rules for SOP flows (standard flowchart symbols, ISO 5807)

Shapes: one per kind of step
- Start and end: Start/stop card (rounded oval). One start, at least one end. Name the trigger ("Order received") and the outcome ("Invoice paid").
- Action: Task card (rectangle). Verb first, one action per card ("Send the quote"). Link it to the real task when there is one.
- Decision: Decision card (diamond). A yes or no question ("Payment received?"). Every exit arrow is labeled (Yes, No, or the case).
- Input or output: Shape, parallelogram. Data or a document coming in or going out ("PO from customer", "Signed quote").
- Document: Shape, document. A form, report or SOP the step makes or uses.
- Data store: Shape, database. The system where the record lives (CRM, Books, Drive).
- Wait or delay: Info card, starting with "Wait:" and how long ("Wait: 2 business days").
- Hand-off to another SOP: Link card to that SOP's document, named "Go to SOP-xx.x".
- Automation: Trigger card for what starts it (schedule, webhook, a task finished), Webhook card for a call to another system.

Who does it: one frame (lane) per role, flow left to right
- Lanes, top to bottom in the order work starts: the person or role, the AI agent, the automation or system.
- Card colors match the lane: person blue, AI agent purple, automation green, outside party yellow, approval gate peach.
- An approval gate is a decision card in the approver's lane ("Approved by David?").

Arrows
- Right angles, flowing left to right (top to bottom inside a lane). No crossing where it can be avoided.
- Label every arrow out of a decision. Dashed arrows only for information that does not start the next step.

On every board
- A title card: SOP code and name, owner, how often it runs.
- A link card to the SOP document.
- A small legend (an Info card) listing the shapes and colors used.
- Each step card says who, when (timing or deadline), and the system it touches.
- Keep to what the SOP says. Anything unclear goes on a sticky note marked "Question:" for a person to answer.`;
