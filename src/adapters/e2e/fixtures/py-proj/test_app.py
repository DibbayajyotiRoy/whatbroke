from app import refresh


# Note: the name stays short/low-entropy so the redaction gate's entropy pass
# never scrubs the test id out of the captured log tail.
def test_refresh_uses_defaults():
    settings = refresh({"retries": 5})
    assert settings == {"retries": 5, "timeout": 30}
