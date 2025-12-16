import asyncio
import aiohttp
import json
import os
from aiohttp import web


COMFY_URL = "http://127.0.0.1:8188"


async def _get_json_with_fallback(session: aiohttp.ClientSession, path: str, fallback_path: str):
    """GET JSON from path, falling back if the first path 404s."""
    url = f"{COMFY_URL}{path}"
    async with session.get(url) as r:
        if r.status == 404:
            url2 = f"{COMFY_URL}{fallback_path}"
            async with session.get(url2) as r2:
                if r2.status != 200:
                    body = await r2.text()
                    raise RuntimeError(f"GET {fallback_path} failed: {r2.status} {body}")
                return await r2.json()

        if r.status != 200:
            body = await r.text()
            raise RuntimeError(f"GET {path} failed: {r.status} {body}")
        return await r.json()


async def _post_json_with_fallback(
    session: aiohttp.ClientSession,
    path: str,
    fallback_path: str,
    payload: dict,
):
    """POST JSON to path, falling back if the first path 404s."""
    url = f"{COMFY_URL}{path}"
    async with session.post(url, json=payload) as r:
        if r.status == 404:
            url2 = f"{COMFY_URL}{fallback_path}"
            async with session.post(url2, json=payload) as r2:
                if r2.status != 200:
                    body = await r2.text()
                    raise RuntimeError(f"POST {fallback_path} failed: {r2.status} {body}")
                return await r2.json()

        if r.status != 200:
            body = await r.text()
            raise RuntimeError(f"POST {path} failed: {r.status} {body}")
        return await r.json()


def _get_output_dir() -> str:
    """Return ComfyUI's configured output directory when running inside ComfyUI."""
    try:
        import folder_paths  # type: ignore

        return folder_paths.get_output_directory()
    except Exception:
        # Fallbacks for running outside ComfyUI
        candidate = os.path.join(os.getcwd(), "ComfyUI", "output")
        if os.path.isdir(candidate):
            return candidate
        return os.path.join(os.getcwd(), "output")


def _find_file_recursive(root_dir: str, filename: str) -> str | None:
    for current_root, _dirs, files in os.walk(root_dir):
        if filename in files:
            return os.path.join(current_root, filename)
    return None

routes = web.RouteTableDef()


# ---------------------------
# helpers
# ---------------------------

async def wait_for_queue_empty(session, timeout=120):
    start = asyncio.get_event_loop().time()
    while True:
        q = await _get_json_with_fallback(session, "/api/queue", "/queue")

        if not q["queue_running"] and not q["queue_pending"]:
            return

        if asyncio.get_event_loop().time() - start > timeout:
            raise TimeoutError("Queue wait timeout")

        await asyncio.sleep(0.3)


async def wait_for_history(session, prompt_id, timeout=120):
    start = asyncio.get_event_loop().time()
    while True:
        history_resp = await _get_json_with_fallback(
            session,
            f"/api/history/{prompt_id}",
            f"/history/{prompt_id}",
        )

        # ComfyUI may return either:
        # 1) {"status": {...}, "outputs": {...}, ...}
        # 2) {"<prompt_id>": {"status": {...}, ...}}
        if isinstance(history_resp, dict) and prompt_id in history_resp and isinstance(history_resp[prompt_id], dict):
            history_item = history_resp[prompt_id]
        else:
            history_item = history_resp

        if isinstance(history_item, dict) and history_item.get("status", {}).get("completed"):
            return history_item

        if asyncio.get_event_loop().time() - start > timeout:
            raise TimeoutError("History wait timeout")

        await asyncio.sleep(0.3)


def extract_png_path(history_item):
    outputs = history_item.get("outputs", {})
    output_dir = _get_output_dir()
    for node in outputs.values():
        if "images" in node:
            img = node["images"][0]
            filename = img["filename"]
            subfolder = img.get("subfolder", "")

            direct_path = os.path.join(output_dir, subfolder, filename)
            if os.path.isfile(direct_path):
                return direct_path

            found = _find_file_recursive(output_dir, filename)
            if found is not None:
                return found

            raise FileNotFoundError(
                f"Image not found on disk. Tried: {direct_path} (and recursive search in {output_dir})"
            )
    raise RuntimeError("No image found in outputs")


# ---------------------------
# /generate endpoint
# ---------------------------

@routes.post("/generate")
async def generate(request):
    """
    Expects:
    {
      "client_id": "...",
      "prompt": "..."   <-- PROMPT TEXT ONLY (the only variable substituted into the workflow template)
    }
    """

    payload = await request.json()

    # ---- HARD VALIDATION (prevents 100% of your crashes)
    prompt_text = payload.get("prompt")
    if not isinstance(prompt_text, str) or not prompt_text.strip():
        return web.json_response({"error": "Invalid prompt"}, status=400)

    prompt_body = r"""{
    "client_id": "700ce14c02494010bc0d1311dd6fef66",
    "prompt": {
        "9": {
            "inputs": {
                "filename_prefix": "z-image",
                "images": [
                    "43",
                    0
                ]
            },
            "class_type": "SaveImage",
            "_meta": {
                "title": "Save Image"
            }
        },
        "39": {
            "inputs": {
                "clip_name": "qwen_3_4b.safetensors",
                "type": "lumina2",
                "device": "default"
            },
            "class_type": "CLIPLoader",
            "_meta": {
                "title": "Load CLIP"
            }
        },
        "40": {
            "inputs": {
                "vae_name": "ae.safetensors"
            },
            "class_type": "VAELoader",
            "_meta": {
                "title": "Load VAE"
            }
        },
        "41": {
            "inputs": {
                "width": 1024,
                "height": 1024,
                "batch_size": 1
            },
            "class_type": "EmptySD3LatentImage",
            "_meta": {
                "title": "EmptySD3LatentImage"
            }
        },
        "42": {
            "inputs": {
                "conditioning": [
                    "45",
                    0
                ]
            },
            "class_type": "ConditioningZeroOut",
            "_meta": {
                "title": "ConditioningZeroOut"
            }
        },
        "43": {
            "inputs": {
                "samples": [
                    "44",
                    0
                ],
                "vae": [
                    "40",
                    0
                ]
            },
            "class_type": "VAEDecode",
            "_meta": {
                "title": "VAE Decode"
            }
        },
        "44": {
            "inputs": {
                "seed": 189091790656961,
                "steps": 9,
                "cfg": 1,
                "sampler_name": "res_multistep",
                "scheduler": "simple",
                "denoise": 1,
                "model": [
                    "47",
                    0
                ],
                "positive": [
                    "45",
                    0
                ],
                "negative": [
                    "42",
                    0
                ],
                "latent_image": [
                    "41",
                    0
                ]
            },
            "class_type": "KSampler",
            "_meta": {
                "title": "KSampler"
            }
        },
        "45": {
            "inputs": {
                "text": "__PROMPT__",
                "clip": [
                    "39",
                    0
                ]
            },
            "class_type": "CLIPTextEncode",
            "_meta": {
                "title": "CLIP Text Encode (Prompt)"
            }
        },
        "46": {
            "inputs": {
                "unet_name": "zImageTurboQuantized_fp8ScaledE4m3fnKJ.safetensors",
                "weight_dtype": "default"
            },
            "class_type": "UNETLoader",
            "_meta": {
                "title": "Load Diffusion Model"
            }
        },
        "47": {
            "inputs": {
                "shift": 3,
                "model": [
                    "46",
                    0
                ]
            },
            "class_type": "ModelSamplingAuraFlow",
            "_meta": {
                "title": "ModelSamplingAuraFlow"
            }
        }
    },
    "extra_data": {
        "extra_pnginfo": {
            "workflow": {
                "id": "9ae6082b-c7f4-433c-9971-7a8f65a3ea65",
                "revision": 0,
                "last_node_id": 57,
                "last_link_id": 61,
                "nodes": [
                    {
                        "id": 40,
                        "type": "VAELoader",
                        "pos": [
                            130.2638101844517,
                            585.2545050421948
                        ],
                        "size": [
                            270,
                            58
                        ],
                        "flags": {},
                        "order": 0,
                        "mode": 0,
                        "inputs": [],
                        "outputs": [
                            {
                                "name": "VAE",
                                "type": "VAE",
                                "links": [
                                    39
                                ]
                            }
                        ],
                        "properties": {
                            "Node name for S&R": "VAELoader",
                            "cnr_id": "comfy-core",
                            "ver": "0.3.73",
                            "models": [
                                {
                                    "name": "ae.safetensors",
                                    "url": "https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors",
                                    "directory": "vae"
                                }
                            ],
                            "enableTabs": false,
                            "tabWidth": 65,
                            "tabXOffset": 10,
                            "hasSecondTab": false,
                            "secondTabText": "Send Back",
                            "secondTabOffset": 80,
                            "secondTabWidth": 65
                        },
                        "widgets_values": [
                            "ae.safetensors"
                        ]
                    },
                    {
                        "id": 42,
                        "type": "ConditioningZeroOut",
                        "pos": [
                            660.2638101844517,
                            725.2545050421948
                        ],
                        "size": [
                            197.712890625,
                            26
                        ],
                        "flags": {},
                        "order": 8,
                        "mode": 0,
                        "inputs": [
                            {
                                "name": "conditioning",
                                "type": "CONDITIONING",
                                "link": 36
                            }
                        ],
                        "outputs": [
                            {
                                "name": "CONDITIONING",
                                "type": "CONDITIONING",
                                "links": [
                                    42
                                ]
                            }
                        ],
                        "properties": {
                            "Node name for S&R": "ConditioningZeroOut",
                            "cnr_id": "comfy-core",
                            "ver": "0.3.73",
                            "enableTabs": false,
                            "tabWidth": 65,
                            "tabXOffset": 10,
                            "hasSecondTab": false,
                            "secondTabText": "Send Back",
                            "secondTabOffset": 80,
                            "secondTabWidth": 65
                        },
                        "widgets_values": []
                    },
                    {
                        "id": 41,
                        "type": "EmptySD3LatentImage",
                        "pos": [
                            130.2638101844517,
                            735.2545050421948
                        ],
                        "size": [
                            260,
                            110
                        ],
                        "flags": {},
                        "order": 1,
                        "mode": 0,
                        "inputs": [],
                        "outputs": [
                            {
                                "name": "LATENT",
                                "type": "LATENT",
                                "slot_index": 0,
                                "links": [
                                    43
                                ]
                            }
                        ],
                        "properties": {
                            "Node name for S&R": "EmptySD3LatentImage",
                            "cnr_id": "comfy-core",
                            "ver": "0.3.64",
                            "enableTabs": false,
                            "tabWidth": 65,
                            "tabXOffset": 10,
                            "hasSecondTab": false,
                            "secondTabText": "Send Back",
                            "secondTabOffset": 80,
                            "secondTabWidth": 65
                        },
                        "widgets_values": [
                            1024,
                            1024,
                            1
                        ]
                    },
                    {
                        "id": 47,
                        "type": "ModelSamplingAuraFlow",
                        "pos": [
                            900.2638101844517,
                            265.2545050421948
                        ],
                        "size": [
                            310,
                            60
                        ],
                        "flags": {},
                        "order": 9,
                        "mode": 0,
                        "inputs": [
                            {
                                "name": "model",
                                "type": "MODEL",
                                "link": 60
                            }
                        ],
                        "outputs": [
                            {
                                "name": "MODEL",
                                "type": "MODEL",
                                "slot_index": 0,
                                "links": [
                                    40
                                ]
                            }
                        ],
                        "properties": {
                            "Node name for S&R": "ModelSamplingAuraFlow",
                            "cnr_id": "comfy-core",
                            "ver": "0.3.64",
                            "enableTabs": false,
                            "tabWidth": 65,
                            "tabXOffset": 10,
                            "hasSecondTab": false,
                            "secondTabText": "Send Back",
                            "secondTabOffset": 80,
                            "secondTabWidth": 65
                        },
                        "widgets_values": [
                            3
                        ]
                    },
                    {
                        "id": 43,
                        "type": "VAEDecode",
                        "pos": [
                            1240,
                            170
                        ],
                        "size": [
                            210,
                            46
                        ],
                        "flags": {},
                        "order": 11,
                        "mode": 0,
                        "inputs": [
                            {
                                "name": "samples",
                                "type": "LATENT",
                                "link": 38
                            },
                            {
                                "name": "vae",
                                "type": "VAE",
                                "link": 39
                            }
                        ],
                        "outputs": [
                            {
                                "name": "IMAGE",
                                "type": "IMAGE",
                                "slot_index": 0,
                                "links": [
                                    45
                                ]
                            }
                        ],
                        "properties": {
                            "Node name for S&R": "VAEDecode",
                            "cnr_id": "comfy-core",
                            "ver": "0.3.64",
                            "enableTabs": false,
                            "tabWidth": 65,
                            "tabXOffset": 10,
                            "hasSecondTab": false,
                            "secondTabText": "Send Back",
                            "secondTabOffset": 80,
                            "secondTabWidth": 65
                        },
                        "widgets_values": []
                    },
                    {
                        "id": 35,
                        "type": "MarkdownNote",
                        "pos": [
                            -390,
                            270
                        ],
                        "size": [
                            490,
                            400
                        ],
                        "flags": {
                            "collapsed": false
                        },
                        "order": 2,
                        "mode": 0,
                        "inputs": [],
                        "outputs": [],
                        "title": "Model link",
                        "properties": {},
                        "widgets_values": [
                            "## Report workflow issue\n\nIf you found any issues when running this workflow, [report template issue here](https://github.com/Comfy-Org/workflow_templates/issues)\n\n\n## Model links\n\n**text_encoders**\n\n- [qwen_3_4b.safetensors](https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/text_encoders/qwen_3_4b.safetensors)\n\n**loras**\n\n- [pixel_art_style_z_image_turbo.safetensors](https://huggingface.co/tarn59/pixel_art_style_lora_z_image_turbo/resolve/main/pixel_art_style_z_image_turbo.safetensors)\n\n**diffusion_models**\n\n- [z_image_turbo_bf16.safetensors](https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/diffusion_models/z_image_turbo_bf16.safetensors)\n\n**vae**\n\n- [ae.safetensors](https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors)\n\n\nModel Storage Location\n\n```\n📂 ComfyUI/\n├── 📂 models/\n│   ├── 📂 text_encoders/\n│   │      └── qwen_3_4b.safetensors\n│   ├── 📂 loras/\n│   │      └── pixel_art_style_z_image_turbo.safetensors\n│   ├── 📂 diffusion_models/\n│   │      └── z_image_turbo_bf16.safetensors\n│   └── 📂 vae/\n│          └── ae.safetensors\n```\n"
                        ],
                        "color": "#432",
                        "bgcolor": "#653"
                    },
                    {
                        "id": 39,
                        "type": "CLIPLoader",
                        "pos": [
                            130.2638101844517,
                            435.2545050421948
                        ],
                        "size": [
                            270,
                            106
                        ],
                        "flags": {},
                        "order": 3,
                        "mode": 0,
                        "inputs": [],
                        "outputs": [
                            {
                                "name": "CLIP",
                                "type": "CLIP",
                                "links": [
                                    44
                                ]
                            }
                        ],
                        "properties": {
                            "Node name for S&R": "CLIPLoader",
                            "cnr_id": "comfy-core",
                            "ver": "0.3.73",
                            "models": [
                                {
                                    "name": "qwen_3_4b.safetensors",
                                    "url": "https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/text_encoders/qwen_3_4b.safetensors",
                                    "directory": "text_encoders"
                                }
                            ],
                            "enableTabs": false,
                            "tabWidth": 65,
                            "tabXOffset": 10,
                            "hasSecondTab": false,
                            "secondTabText": "Send Back",
                            "secondTabOffset": 80,
                            "secondTabWidth": 65
                        },
                        "widgets_values": [
                            "qwen_3_4b.safetensors",
                            "lumina2",
                            "default"
                        ]
                    },
                    {
                        "id": 46,
                        "type": "UNETLoader",
                        "pos": [
                            130.2638101844517,
                            305.2545050421948
                        ],
                        "size": [
                            270,
                            82
                        ],
                        "flags": {},
                        "order": 4,
                        "mode": 0,
                        "inputs": [],
                        "outputs": [
                            {
                                "name": "MODEL",
                                "type": "MODEL",
                                "links": [
                                    54
                                ]
                            }
                        ],
                        "properties": {
                            "Node name for S&R": "UNETLoader",
                            "cnr_id": "comfy-core",
                            "ver": "0.3.73",
                            "models": [
                                {
                                    "name": "z_image_turbo_bf16.safetensors",
                                    "url": "https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/diffusion_models/z_image_turbo_bf16.safetensors",
                                    "directory": "diffusion_models"
                                }
                            ],
                            "enableTabs": false,
                            "tabWidth": 65,
                            "tabXOffset": 10,
                            "hasSecondTab": false,
                            "secondTabText": "Send Back",
                            "secondTabOffset": 80,
                            "secondTabWidth": 65
                        },
                        "widgets_values": [
                            "zImageTurboQuantized_fp8ScaledE4m3fnKJ.safetensors",
                            "default"
                        ]
                    },
                    {
                        "id": 44,
                        "type": "KSampler",
                        "pos": [
                            900.2638101844517,
                            375.2545050421948
                        ],
                        "size": [
                            315,
                            474
                        ],
                        "flags": {},
                        "order": 10,
                        "mode": 0,
                        "inputs": [
                            {
                                "name": "model",
                                "type": "MODEL",
                                "link": 40
                            },
                            {
                                "name": "positive",
                                "type": "CONDITIONING",
                                "link": 41
                            },
                            {
                                "name": "negative",
                                "type": "CONDITIONING",
                                "link": 42
                            },
                            {
                                "name": "latent_image",
                                "type": "LATENT",
                                "link": 43
                            }
                        ],
                        "outputs": [
                            {
                                "name": "LATENT",
                                "type": "LATENT",
                                "slot_index": 0,
                                "links": [
                                    38
                                ]
                            }
                        ],
                        "properties": {
                            "Node name for S&R": "KSampler",
                            "cnr_id": "comfy-core",
                            "ver": "0.3.64",
                            "enableTabs": false,
                            "tabWidth": 65,
                            "tabXOffset": 10,
                            "hasSecondTab": false,
                            "secondTabText": "Send Back",
                            "secondTabOffset": 80,
                            "secondTabWidth": 65
                        },
                        "widgets_values": [
                            189091790656961,
                            "randomize",
                            9,
                            1,
                            "res_multistep",
                            "simple",
                            1
                        ]
                    },
                    {
                        "id": 9,
                        "type": "SaveImage",
                        "pos": [
                            1240,
                            260
                        ],
                        "size": [
                            780,
                            660
                        ],
                        "flags": {},
                        "order": 12,
                        "mode": 0,
                        "inputs": [
                            {
                                "name": "images",
                                "type": "IMAGE",
                                "link": 45
                            }
                        ],
                        "outputs": [],
                        "properties": {
                            "Node name for S&R": "SaveImage",
                            "cnr_id": "comfy-core",
                            "ver": "0.3.64",
                            "enableTabs": false,
                            "tabWidth": 65,
                            "tabXOffset": 10,
                            "hasSecondTab": false,
                            "secondTabText": "Send Back",
                            "secondTabOffset": 80,
                            "secondTabWidth": 65
                        },
                        "widgets_values": [
                            "z-image"
                        ]
                    },
                    {
                        "id": 56,
                        "type": "Note",
                        "pos": [
                            901.2265634471929,
                            129.69038197857955
                        ],
                        "size": [
                            210,
                            88
                        ],
                        "flags": {},
                        "order": 5,
                        "mode": 0,
                        "inputs": [],
                        "outputs": [],
                        "title": "LoRA trigger word",
                        "properties": {},
                        "widgets_values": [
                            "Pixel art style"
                        ],
                        "color": "#432",
                        "bgcolor": "#653"
                    },
                    {
                        "id": 48,
                        "type": "LoraLoaderModelOnly",
                        "pos": [
                            460,
                            140
                        ],
                        "size": [
                            370,
                            82
                        ],
                        "flags": {},
                        "order": 7,
                        "mode": 4,
                        "inputs": [
                            {
                                "name": "model",
                                "type": "MODEL",
                                "link": 54
                            }
                        ],
                        "outputs": [
                            {
                                "name": "MODEL",
                                "type": "MODEL",
                                "links": [
                                    60
                                ]
                            }
                        ],
                        "properties": {
                            "Node name for S&R": "LoraLoaderModelOnly",
                            "cnr_id": "comfy-core",
                            "ver": "0.3.75",
                            "models": [
                                {
                                    "name": "pixel_art_style_z_image_turbo.safetensors",
                                    "url": "https://huggingface.co/tarn59/pixel_art_style_lora_z_image_turbo/resolve/main/pixel_art_style_z_image_turbo.safetensors",
                                    "directory": "loras"
                                }
                            ],
                            "enableTabs": false,
                            "tabWidth": 65,
                            "tabXOffset": 10,
                            "hasSecondTab": false,
                            "secondTabText": "Send Back",
                            "secondTabOffset": 80,
                            "secondTabWidth": 65
                        },
                        "widgets_values": [
                            "dark_art_style_z_image_turbo.safetensors",
                            1
                        ]
                    },
                    {
                        "id": 45,
                        "type": "CLIPTextEncode",
                        "pos": [
                            450.2638101844517,
                            305.2545050421948
                        ],
                        "size": [
                            410,
                            370
                        ],
                        "flags": {},
                        "order": 6,
                        "mode": 0,
                        "inputs": [
                            {
                                "name": "clip",
                                "type": "CLIP",
                                "link": 44
                            }
                        ],
                        "outputs": [
                            {
                                "name": "CONDITIONING",
                                "type": "CONDITIONING",
                                "links": [
                                    36,
                                    41
                                ]
                            }
                        ],
                        "properties": {
                            "Node name for S&R": "CLIPTextEncode",
                            "cnr_id": "comfy-core",
                            "ver": "0.3.73",
                            "enableTabs": false,
                            "tabWidth": 65,
                            "tabXOffset": 10,
                            "hasSecondTab": false,
                            "secondTabText": "Send Back",
                            "secondTabOffset": 80,
                            "secondTabWidth": 65
                        },
                        "widgets_values": [
                            "A cinematic shot of a futuristic cyberpunk city with neon lights, rain on the streets, highly detailed, photorealistic, 8k"
                        ],
                        "color": "#232",
                        "bgcolor": "#353"
                    }
                ],
                "links": [
                    [
                        36,
                        45,
                        0,
                        42,
                        0,
                        "CONDITIONING"
                    ],
                    [
                        38,
                        44,
                        0,
                        43,
                        0,
                        "LATENT"
                    ],
                    [
                        39,
                        40,
                        0,
                        43,
                        1,
                        "VAE"
                    ],
                    [
                        40,
                        47,
                        0,
                        44,
                        0,
                        "MODEL"
                    ],
                    [
                        41,
                        45,
                        0,
                        44,
                        1,
                        "CONDITIONING"
                    ],
                    [
                        42,
                        42,
                        0,
                        44,
                        2,
                        "CONDITIONING"
                    ],
                    [
                        43,
                        41,
                        0,
                        44,
                        3,
                        "LATENT"
                    ],
                    [
                        44,
                        39,
                        0,
                        45,
                        0,
                        "CLIP"
                    ],
                    [
                        45,
                        43,
                        0,
                        9,
                        0,
                        "IMAGE"
                    ],
                    [
                        54,
                        46,
                        0,
                        48,
                        0,
                        "MODEL"
                    ],
                    [
                        60,
                        48,
                        0,
                        47,
                        0,
                        "MODEL"
                    ]
                ],
                "groups": [
                    {
                        "id": 2,
                        "title": "Step2 - Image size",
                        "bounding": [
                            120,
                            670,
                            290,
                            200
                        ],
                        "color": "#3f789e",
                        "font_size": 24,
                        "flags": {}
                    },
                    {
                        "id": 3,
                        "title": "Step3 - Prompt",
                        "bounding": [
                            430,
                            240,
                            450,
                            540
                        ],
                        "color": "#3f789e",
                        "font_size": 24,
                        "flags": {}
                    },
                    {
                        "id": 4,
                        "title": "Step1 - Load models",
                        "bounding": [
                            120,
                            240,
                            290,
                            413.6
                        ],
                        "color": "#3f789e",
                        "font_size": 24,
                        "flags": {}
                    },
                    {
                        "id": 5,
                        "title": "Ctrl-B to enable LoRA input",
                        "bounding": [
                            430,
                            70,
                            440,
                            160
                        ],
                        "color": "#3f789e",
                        "font_size": 24,
                        "flags": {}
                    }
                ],
                "config": {},
                "extra": {
                    "ds": {
                        "scale": 0.5730621617280598,
                        "offset": [
                            878.0504663859169,
                            322.9376750988064
                        ]
                    },
                    "frontendVersion": "1.33.13",
                    "VHS_latentpreview": false,
                    "VHS_latentpreviewrate": 0,
                    "VHS_MetadataImage": true,
                    "VHS_KeepIntermediate": true,
                    "workflowRendererVersion": "LG"
                },
                "version": 0.4
            }
        }
    }
}
"""
    # Only variable substitution: payload["prompt"]
    try:
        prompt_json = prompt_body.replace('"__PROMPT__"', json.dumps(prompt_text))
        clean_payload = json.loads(prompt_json)
    except json.JSONDecodeError as e:
        return web.json_response(
            {"error": f"Internal workflow template JSON error: {e}"},
            status=500,
        )

    # Allow caller to override client_id (useful for websocket-based clients)
    clean_payload["client_id"] = payload.get(
        "client_id",
        clean_payload.get("client_id", "api-client"),
    )

    async with aiohttp.ClientSession() as session:

        # 1️⃣ submit prompt
        submit = await _post_json_with_fallback(session, "/api/prompt", "/prompt", clean_payload)

        prompt_id = submit["prompt_id"]

        # 2️⃣ wait until queue is empty
        await wait_for_queue_empty(session)

        # 3️⃣ wait for history result
        history_item = await wait_for_history(session, prompt_id)

        # 4️⃣ locate output PNG
        try:
            image_path = extract_png_path(history_item)
        except Exception as e:
            return web.json_response(
                {
                    "error": str(e),
                    "prompt_id": prompt_id,
                    "output_dir": _get_output_dir(),
                },
                status=500,
            )

    # 5️⃣ return PNG bytes
    return web.FileResponse(
        image_path,
        headers={
            "Content-Type": "image/png",
            "X-Prompt-ID": prompt_id
        }
    )


# ---------------------------
# app init
# ---------------------------

def register_routes(app):
    app.add_routes(routes)