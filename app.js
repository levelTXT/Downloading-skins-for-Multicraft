const state = {
    confLines: null,
    slotsData: null,
    canvasArray: null,
    confReady: false,
    skinReady: false
};

const $ = id => document.getElementById(id);

function showStatus(msg, kind = "info") {
    const box = $("statusBox");
    box.className = `status ${kind}`;
    box.textContent = msg;
}

function updateButton() {
    $("saveBtn").disabled = !(state.confReady && state.skinReady);
}

async function decodeSavesString(b64Str) {
    let clean = b64Str.trim();
    const rem = clean.length % 4;
    if (rem) clean += "=".repeat(4 - rem);

    const binary = atob(clean);
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));

    const ds = new DecompressionStream("deflate");
    const writer = ds.writable.getWriter();
    writer.write(bytes);
    writer.close();

    const outBuf = await new Response(ds.readable).arrayBuffer();
    const text = new TextDecoder("utf-8").decode(outBuf);
    return JSON.parse(text);
}

async function encodeSavesString(dataObj) {
    const jsonStr = JSON.stringify(dataObj);
    const bytes = new TextEncoder().encode(jsonStr);

    const cs = new CompressionStream("deflate");
    const writer = cs.writable.getWriter();
    writer.write(bytes);
    writer.close();

    const outBuf = await new Response(cs.readable).arrayBuffer();
    const compressed = new Uint8Array(outBuf);

    let binary = "";
    for (let i = 0; i < compressed.length; i++) {
        binary += String.fromCharCode(compressed.at(i));
    }
    return btoa(binary);
}

function rgbToHex(rgb) {
    if (!rgb || typeof rgb !== "object") return "#FFFFFF";
    const toHex = n => Math.max(0, Math.min(255, Number(n) || 0)).toString(16).padStart(2, "0").toUpperCase();
    return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`;
}

function hexToRgb(hex) {
    const clean = hex.replace(/^#/, "");
    if (!/^[0-9A-Fa-f]{6}$/.test(clean)) {
        throw new Error("HEX-код должен состоять из 6 символов (например, #FF00AA)");
    }
    return {
        r: parseInt(clean.slice(0, 2), 16),
        g: parseInt(clean.slice(2, 4), 16),
        b: parseInt(clean.slice(4, 6), 16)
    };
}

function syncColorFromSlot() {
    const idx = Number($("slotSelect").value);
    if (!state.slotsData || isNaN(idx)) return;
    const hex = rgbToHex(state.slotsData.at(idx).nametag_color);
    $("colorPicker").value = hex.toLowerCase();
    $("hexInput").value = hex;
}

async function processConfText(text) {
    const lines = text.split(/(?<=\n)/);
    const prefix = "edit_skin.saves =";
    let encodedVal = null;

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith(prefix)) {
            encodedVal = trimmed.slice(prefix.length).trim();
            break;
        }
    }

    if (!encodedVal) {
        state.confReady = false;
        updateButton();
        return showStatus("Ошибка: в файле не найдена строка 'edit_skin.saves ='!", "error");
    }

    try {
        const slots = await decodeSavesString(encodedVal);
        if (!Array.isArray(slots) || slots.length === 0) {
            throw new Error("Список слотов пуст или поврежден.");
        }
        state.confLines = lines;
        state.slotsData = slots;
        state.confReady = true;

        const select = $("slotSelect");
        select.innerHTML = "";
        slots.forEach((_, i) => {
            const opt = document.createElement("option");
            opt.value = i;
            opt.textContent = `Слот №${i + 1}`;
            select.appendChild(opt);
        });

        select.disabled = false;
        $("colorPicker").disabled = false;
        $("hexInput").disabled = false;
        syncColorFromSlot();
        updateButton();
        showStatus(`Конфиг загружен! Найдено слотов: ${slots.length}.`, "info");
    } catch (err) {
        state.confReady = false;
        updateButton();
        showStatus(`Ошибка расшифровки сохранений: ${err.message}`, "error");
    }
}

async function readBlobSafe(file) {
    // 1. Пробуем современный arrayBuffer()
    const buf = await file.arrayBuffer();
    if (buf.byteLength > 0) {
        return new TextDecoder("utf-8").decode(buf);
    }
    // 2. Пробуем чтение через поток (обходит баг 0 байт в некоторых версиях Chrome)
    const reader = file.stream().getReader();
    const chunks = [];
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
    }
    const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
    if (totalLen > 0) {
        const merged = new Uint8Array(totalLen);
        let offset = 0;
        for (const c of chunks) {
            merged.set(c, offset);
            offset += c.length;
        }
        return new TextDecoder("utf-8").decode(merged);
    }
    return "";
}

$("confInput").addEventListener("change", async (e) => {
    const file = e.target.files.item(0);
    if (!file) return;

    try {
        const content = await readBlobSafe(file);
        if (!content || content.length === 0) {
            state.confReady = false;
            updateButton();
            return showStatus(
                `Chrome на Android заблокировал расширение "${file.name}" (отдал 0 байт). Переименуйте файл в multicraft.txt или вставьте его текст в поле ниже.`,
                "error"
            );
        }
        $("confPaste").value = content;
        await processConfText(content);
    } catch (err) {
        showStatus(`Ошибка чтения файла: ${err.message}`, "error");
    }
});

$("confPaste").addEventListener("input", async (e) => {
    const val = e.target.value;
    if (val.includes("edit_skin.saves")) {
        await processConfText(val);
    }
});

$("skinInput").addEventListener("change", (e) => {
    const file = e.target.files.item(0);
    if (!file) return;

    const url = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
        if (img.width !== 128 || img.height !== 128) {
            state.skinReady = false;
            updateButton();
            $("skinPreview").style.display = "none";
            $("skinInfo").textContent = `Ошибка размера: ${img.width}×${img.height} px`;
            URL.revokeObjectURL(url);
            return showStatus(`Картинка должна быть строго 128×128 px! Ваша: ${img.width}×${img.height}.`, "error");
        }

        const ctx = $("hiddenCanvas").getContext("2d");
        ctx.clearRect(0, 0, 128, 128);
        ctx.drawImage(img, 0, 0);
        const data = ctx.getImageData(0, 0, 128, 128).data;

        const colorArray = [];
        const toHex = n => n.toString(16).padStart(2, "0").toUpperCase();

        for (let i = 0; i < data.length; i += 4) {
            const r = data.at(i), g = data.at(i + 1), b = data.at(i + 2), a = data.at(i + 3);
            colorArray.push(a < 10 ? null : `#${toHex(r)}${toHex(g)}${toHex(b)}`);
        }

        state.canvasArray = colorArray;
        state.skinReady = true;

        $("skinPreview").src = url;
        $("skinPreview").style.display = "block";
        $("skinInfo").textContent = "Размер 128×128 подтверждён ✅";
        updateButton();

        if (state.confReady) {
            showStatus("Всё готово! Нажмите кнопку ниже, чтобы скачать файл.", "info");
        }
    };

    img.onerror = () => {
        state.skinReady = false;
        updateButton();
        showStatus("Не удалось прочитать изображение.", "error");
    };

    img.src = url;
});

$("slotSelect").addEventListener("change", syncColorFromSlot);

$("colorPicker").addEventListener("input", (e) => {
    $("hexInput").value = e.target.value.toUpperCase();
});

$("hexInput").addEventListener("input", (e) => {
    let val = e.target.value.trim();
    if (!val.startsWith("#")) val = "#" + val;
    if (/^#[0-9A-Fa-f]{6}$/.test(val)) {
        $("colorPicker").value = val.toLowerCase();
    }
});

$("saveBtn").addEventListener("click", async () => {
    if (!state.confReady || !state.skinReady) return;

    try {
        const slotIdx = Number($("slotSelect").value);
        const newRgb = hexToRgb($("hexInput").value.trim());

        const targetSlot = state.slotsData.at(slotIdx);
        if (!targetSlot.skin) targetSlot.skin = {};
        targetSlot.skin.canvas = state.canvasArray;
        targetSlot.skin.use_canvas = true;
        targetSlot.nametag_color = newRgb;

        const newEncoded = await encodeSavesString(state.slotsData);
        const prefix = "edit_skin.saves =";
        const newLines = [];
        let updated = false;

        for (const line of state.confLines) {
            if (line.trim().startsWith(prefix)) {
                const leading = line.slice(0, line.length - line.trimStart().length);
                newLines.push(`${leading}${prefix} ${newEncoded}\n`);
                updated = true;
            } else {
                newLines.push(line);
            }
        }

        if (!updated) {
            newLines.push(`\n${prefix} ${newEncoded}\n`);
        }

        const finalConf = newLines.join("");
        $("confPaste").value = finalConf;

        const blob = new Blob([finalConf], { type: "text/plain;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "multicraft.conf";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        showStatus(`Готово! Слот №${slotIdx + 1} обновлен. Файл multicraft.conf скачан (и обновлен в поле выше).`, "success");
    } catch (err) {
        showStatus(`Ошибка при сборке конфига: ${err.message}`, "error");
    }
});
