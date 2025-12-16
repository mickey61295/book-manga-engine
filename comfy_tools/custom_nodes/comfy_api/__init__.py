from server import PromptServer
from .api import register_routes

# ---- REQUIRED BY COMFYUI ----
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

# ---- REGISTER API ROUTES ----
ps = PromptServer.instance
register_routes(ps.app)
