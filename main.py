import json
import zlib
import base64
from pyscript import document, window
from pyodide.ffi import create_proxy

state = {
    "conf_lines": None,
    "slots_data": None,
    "canvas_array": None,
    "conf_ready": False,
    "skin_ready": False
}

def show_status(msg, kind="info"):
    box = document.getElementById("statusBox")
    box.className = f"status {kind}"
    box.innerText = msg

def update_button_state():
    document.getElementById("saveBtn").disabled = not (state["conf_ready"] and state["skin_ready"])

def decode_saves_string(b64_str):
    b64_str = b64_str.strip()
    rem = len(b64_str) % 4
    if rem:
        b64_str += "=" * (4 - rem)
    compressed = base64.b64decode(b64_str)
    unpacked = zlib.decompressobj().decompress(compressed)
    return json.loads(unpacked.decode("utf-8", errors="ignore"))

def encode_saves_string(data_obj):
    raw_json = json.dumps(data_obj, separators=(",", ":"))
    compressed = zlib.compress(raw_json.encode("utf-8"))
    return base64.b64encode(compressed).decode("utf-8")

def rgb_dict_to_hex(rgb_dict):
    if not isinstance(rgb_dict, dict):
        return "#FFFFFF"
    r = int(rgb_dict.get("r", 255))
    g = int(rgb_dict.get("g", 255))
    b = int(rgb_dict.get("b", 255))
    return f"#{r:02X}{g:02X}{b:02X}"

def hex_to_rgb_dict(hex_str):
    hex_str = hex_str.lstrip("#")
    if len(hex_str) != 6:
        raise ValueError("HEX-код должен состоять из 6 символов (например, #FF00AA)")
    return {
        "r": int(hex_str[0:2], 16),
        "g": int(hex_str[2:4], 16),
        "b": int(hex_str[4:6], 16)
    }

def sync_color_from_slot():
    select = document.getElementById("slotSelect")
    if not select.value or not state["slots_data"]:
        return
    idx = int(select.value)
    current_hex = rgb_dict_to_hex(state["slots_data"][idx].get("nametag_color"))
    document.getElementById("colorPicker").value = current_hex.lower()
    document.getElementById("hexInput").value = current_hex

async def on_conf_upload(event):
    files = event.target.files
    if not files or files.length == 0:
        return
    text = await files.item(0).text()
    lines = text.splitlines(keepends=True)

    target_prefix = "edit_skin.saves ="
    encoded_val = None
    for line in lines:
        stripped = line.strip()
        if stripped.startswith(target_prefix):
            encoded_val = stripped[len(target_prefix):].strip()
            break

    if not encoded_val:
        state["conf_ready"] = False
        update_button_state()
        show_status("Ошибка: в файле не найдена строка 'edit_skin.saves ='!", "error")
        return

    try:
        slots = decode_saves_string(encoded_val)
        if not isinstance(slots, list) or len(slots) == 0:
            raise ValueError("Список слотов пуст.")
    except Exception as e:
        state["conf_ready"] = False
        update_button_state()
        show_status(f"Ошибка расшифровки сохранений: {e}", "error")
        return

    state["conf_lines"] = lines
    state["slots_data"] = slots
    state["conf_ready"] = True

    select = document.getElementById("slotSelect")
    select.innerHTML = ""
    for i in range(len(slots)):
        opt = document.createElement("option")
        opt.value = str(i)
        opt.text = f"Слот №{i + 1}"
        select.appendChild(opt)

    select.disabled = False
    document.getElementById("colorPicker").disabled = False
    document.getElementById("hexInput").disabled = False
    sync_color_from_slot()
    update_button_state()
    show_status(f"Конфиг загружен! Найдено слотов: {len(slots)}.", "info")

def on_skin_upload(event):
    files = event.target.files
    if not files or files.length == 0:
        return
    file = files.item(0)
    url = window.URL.createObjectURL(file)
    img = window.Image.new()

    def on_img_load(e):
        w, h = img.width, img.height
        preview = document.getElementById("skinPreview")
        info = document.getElementById("skinInfo")

        if (w, h) != (128, 128):
            state["skin_ready"] = False
            update_button_state()
            preview.style.display = "none"
            info.innerText = f"Ошибка размера: {w}×{h} px"
            show_status(f"Картинка должна быть строго 128×128 px! Ваша: {w}×{h}.", "error")
            window.URL.revokeObjectURL(url)
            return

        canvas = document.getElementById("hiddenCanvas")
        ctx = canvas.getContext("2d")
        ctx.clearRect(0, 0, 128, 128)
        ctx.drawImage(img, 0, 0)
        pixels = ctx.getImageData(0, 0, 128, 128).data.to_py()

        color_array = []
        for i in range(0, len(pixels), 4):
            r, g, b, a = pixels[i], pixels[i+1], pixels[i+2], pixels[i+3]
            color_array.append(None if a < 10 else f"#{r:02X}{g:02X}{b:02X}")

        state["canvas_array"] = color_array
        state["skin_ready"] = True

        preview.src = url
        preview.style.display = "block"
        info.innerText = "Размер 128×128 подтверждён ✅"

        update_button_state()
        if state["conf_ready"]:
            show_status("Всё готово! Нажмите кнопку ниже, чтобы скачать файл.", "info")

    img.onload = create_proxy(on_img_load)
    img.src = url

def on_slot_change(event):
    sync_color_from_slot()

def on_picker_input(event):
    document.getElementById("hexInput").value = event.target.value.upper()

def on_hex_input(event):
    val = event.target.value.strip()
    if not val.startswith("#"):
        val = "#" + val
    if len(val) == 7:
        try:
            int(val[1:], 16)
            document.getElementById("colorPicker").value = val.lower()
        except ValueError:
            pass

def on_save_click(event):
    if not (state["conf_ready"] and state["skin_ready"]):
        return
    try:
        slot_idx = int(document.getElementById("slotSelect").value)
        new_rgb = hex_to_rgb_dict(document.getElementById("hexInput").value.strip())

        target_slot = state["slots_data"][slot_idx]
        if "skin" not in target_slot:
            target_slot["skin"] = {}
        target_slot["skin"]["canvas"] = state["canvas_array"]
        target_slot["skin"]["use_canvas"] = True
        target_slot["nametag_color"] = new_rgb

        new_encoded = encode_saves_string(state["slots_data"])
        target_prefix = "edit_skin.saves ="
        new_lines = []
        updated = False

        for line in state["conf_lines"]:
            if line.strip().startswith(target_prefix):
                leading = line[:len(line) - len(line.lstrip())]
                new_lines.append(f"{leading}{target_prefix} {new_encoded}\n")
                updated = True
            else:
                new_lines.append(line)

        if not updated:
            new_lines.append(f"\n{target_prefix} {new_encoded}\n")

        blob = window.Blob.new(["".join(new_lines)], {"type": "text/plain;charset=utf-8"})
        url = window.URL.createObjectURL(blob)
        link = document.createElement("a")
        link.href = url
        link.download = "multicraft.conf"
        document.body.appendChild(link)
        link.click()
        document.body.removeChild(link)
        window.URL.revokeObjectURL(url)

        show_status(f"Готово! Слот №{slot_idx + 1} обновлен, файл multicraft.conf скачан.", "success")
    except Exception as e:
        show_status(f"Ошибка при сборке конфига: {e}", "error")

document.getElementById("confInput").addEventListener("change", create_proxy(on_conf_upload))
document.getElementById("skinInput").addEventListener("change", create_proxy(on_skin_upload))
document.getElementById("slotSelect").addEventListener("change", create_proxy(on_slot_change))
document.getElementById("colorPicker").addEventListener("input", create_proxy(on_picker_input))
document.getElementById("hexInput").addEventListener("input", create_proxy(on_hex_input))
document.getElementById("saveBtn").addEventListener("click", create_proxy(on_save_click))

document.getElementById("loader").style.display = "none"
document.getElementById("app").style.display = "block"
