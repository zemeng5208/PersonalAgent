"""AgentArts intent workflow body; routes only to the configured strict router.

This is a cloud routing decision, never a local authorization or execution.
The official messages/intents input contract is populated by the controller.
"""


def main(args: dict) -> dict:
    intents = args.get("intents")
    if not isinstance(intents, list) or len(intents) > 64:
        return {"intent_id": 1}
    matches = []
    for item in intents:
        if not isinstance(item, dict):
            return {"intent_id": 1}
        intent_id = item.get("id")
        name = item.get("name")
        if not isinstance(intent_id, int) or isinstance(intent_id, bool):
            return {"intent_id": 1}
        if name == "PA-MVP-受限主路由" and intent_id > 1:
            matches.append(intent_id)
    return {"intent_id": matches[0] if len(matches) == 1 else 1}
