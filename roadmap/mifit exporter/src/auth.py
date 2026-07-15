import logging
from pathlib import Path
from typing import Optional

from furl import furl
from install_playwright import install

from src import constants

_logger = logging.getLogger(__name__)

TOKEN_DEFAULT_PATH = Path(".token")


def save_token(token: str, path: Path = TOKEN_DEFAULT_PATH) -> None:
    path.write_text(token)
    path.chmod(0o600)
    _logger.info(f"Token saved to {path}")


def load_token(path: Path = TOKEN_DEFAULT_PATH) -> Optional[str]:
    if path.exists():
        token = path.read_text().strip()
        if token:
            _logger.info(f"Using cached token from {path}")
            return token
    return None


def _get_gdpr_url() -> str:
    return furl(
        "https://user.huami.com/privacy2/index.html",
        args={
            "platform_app": constants.APP_NAME,
            "loginPlatform": constants.APP_PLATFORM,
        },
    ).url


def get_app_token() -> Optional[str]:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        _logger.error(
            "Couldn't find playwright, "
            "please provide the token manually using the -t argument"
        )
        return None

    with sync_playwright() as playwright:
        install(playwright.firefox)
        browser = playwright.firefox.launch(headless=False)
        page = browser.new_page()

        _logger.info("Opening GDPR URL")
        page.goto(_get_gdpr_url())

        _logger.info("Waiting for export data button to appear")
        export_data_locator = page.locator("div.gdpr-operation-output")
        export_data_locator.click()

        _logger.info("Waiting for login")
        export_data_locator = page.locator("div.gdpr-operation-output")
        export_data_locator.wait_for(timeout=0)

        if not (
            token_cookie := next(
                (c for c in page.context.cookies() if c.get("name") == "apptoken"), None
            )
        ):
            _logger.error(
                "Couldn't extract the app token automatically, "
                "please provide it manually using the -t argument"
            )
            return None

        browser.close()
        return token_cookie.get("value")
