// WebGL 컨텍스트
const canvas = document.getElementById("canvas");
const gridCanvas = document.getElementById("grid-canvas");
const gl = canvas.getContext("webgl2");
const gridGl = gridCanvas.getContext("webgl2");

if (!gl || !gridGl) {
  alert("WebGL 2.0을 지원하지 않는 브라우저입니다.");
  throw new Error("WebGL 2.0 not supported");
}

// 전역 변수
let program = null;
let gridProgram = null;
let startTime = Date.now();
let frameCount = 0;
let lastFpsTime = Date.now();
let animationId = null;

// 그리드 모드
let isGridMode = false;
let gridCols = 3;
let gridRows = 3;
let loopDuration = 3.0;
let playbackSpeed = 1.0;
let loopMode = "pingpong";
let cellTimeOffsets = [];
let cellParamVariations = {}; // { paramName: { mode, minValue, maxValue, values: [] } }

// 녹화
let mediaRecorder = null;
let recordedChunks = [];
let isRecording = false;
let recordingStartTime = 0;
let recordingTargetDuration = 0;
let autoStopEnabled = false;

// 파라미터
let shaderParams = {};
let paramsPanelMinimized = false;

// 마우스
let mouseX = 0,
  mouseY = 0,
  mouseDown = false;

// 해상도 설정
function setResolution(width, height) {
  canvas.width = width;
  canvas.height = height;
  gridCanvas.width = width;
  gridCanvas.height = height;
  document.getElementById("resolution-info").textContent = `${width}×${height}`;
  gl.viewport(0, 0, width, height);
  gridGl.viewport(0, 0, width, height);
}

setResolution(1920, 1080);

// Vertex Shader
const vertexShaderSource = `#version 300 es
  in vec2 position;
  void main() {
    gl_Position = vec4(position, 0.0, 1.0);
  }
`;

// Fragment Shader 빌드
function buildFragmentShader(userCode, forGrid = false) {
  const offsetUniform = forGrid ? "uniform vec2 iOffset;" : "";
  const fragCoordAdjust = forGrid
    ? "gl_FragCoord.xy - iOffset"
    : "gl_FragCoord.xy";

  if (userCode.includes("void mainImage")) {
    return `#version 300 es
      precision highp float;
      uniform vec2 iResolution;
      uniform float iTime;
      uniform vec4 iMouse;
      uniform int iFrame;
      ${offsetUniform}
      ${generateParamUniforms()}
      out vec4 fragColor;
      ${userCode}
      void main() {
        mainImage(fragColor, ${fragCoordAdjust});
      }
    `;
  }
  return `#version 300 es
    precision highp float;
    uniform vec2 iResolution;
    uniform float iTime;
    ${offsetUniform}
    ${generateParamUniforms()}
    out vec4 fragColor;
    ${userCode}
  `;
}

function generateParamUniforms() {
  return Object.keys(shaderParams)
    .map((name) => `uniform float ${name};`)
    .join("\n");
}

// 파라미터 파싱
function parseParameters(code) {
  const params = {};
  const regex =
    /#pragma\s+param\s+(\w+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)(?:\s+([-\d.]+))?/g;
  let match;
  while ((match = regex.exec(code)) !== null) {
    const [, name, min, max, defaultVal, step] = match;
    params[name] = {
      name,
      min: parseFloat(min),
      max: parseFloat(max),
      default: parseFloat(defaultVal),
      value: parseFloat(defaultVal),
      step: step ? parseFloat(step) : (parseFloat(max) - parseFloat(min)) / 100,
    };
  }
  return params;
}

// 파라미터 UI 업데이트
function updateParameterUI() {
  const content = document.getElementById("params-content");
  shaderParams = parseParameters(document.getElementById("shader-code").value);

  if (Object.keys(shaderParams).length === 0) {
    content.innerHTML =
      '<div class="text-xs text-gray-400 text-center py-8">파라미터가 없습니다</div>';
    return;
  }

  content.innerHTML = Object.keys(shaderParams)
    .map((name) => {
      const p = shaderParams[name];
      const hasVariation = cellParamVariations[name];
      return `
      <div class="mb-4">
        <div class="flex justify-between items-center mb-1.5">
          <span class="text-xs text-[#4ec9b0] font-medium">${name}</span>
          <span class="text-xs text-gray-400" id="value-${name}">${p.value.toFixed(
        3
      )}</span>
        </div>
        <div class="flex items-center gap-2">
          <input type="range" class="flex-1 h-1.5 bg-[#3c3c3c] rounded appearance-none cursor-pointer
                 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 
                 [&::-webkit-slider-thumb]:bg-[#4ec9b0] [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:cursor-pointer"
                 id="slider-${name}" min="${p.min}" max="${p.max}" step="${
        p.step
      }" value="${p.value}">
          <input type="number" class="w-16 bg-[#3c3c3c] text-[#d4d4d4] border border-[#555] px-1.5 py-1 rounded text-xs text-center"
                 id="input-${name}" min="${p.min}" max="${p.max}" step="${
        p.step
      }" value="${p.value}">
          <button class="bg-[#3c3c3c] hover:bg-[#0e639c] text-[#d4d4d4] px-2 py-1 rounded text-xs" onclick="resetParam('${name}')">↺</button>
          <button class="param-vary-btn ${
            hasVariation ? "bg-[#4ec9b0]" : "bg-[#3c3c3c]"
          } hover:bg-[#0e639c] text-[#d4d4d4] px-2 py-1 rounded text-xs" 
                  onclick="toggleParamVariation('${name}')">그리드</button>
        </div>
        <div class="flex justify-between text-[10px] text-gray-500 mt-1">
          <span>${p.min}</span>
          <span>${p.max}</span>
        </div>
        
        <!-- 그리드 입력 UI -->
        <div id="variation-${name}" class="hidden mt-2 p-2 bg-[#1e1e1e] border border-[#3c3c3c] rounded max-h-[300px] overflow-y-auto custom-scrollbar">
          <div class="flex justify-between items-center mb-2">
            <span class="text-[10px] text-gray-400 font-bold">각 셀 ${name} 값</span>
            <div class="flex gap-1">
              <button class="bg-[#3c3c3c] hover:bg-[#0e639c] text-[#d4d4d4] px-2 py-0.5 rounded text-[10px]" 
                      onclick="fillAllCells('${name}')">전체 채우기</button>
              <button class="bg-[#3c3c3c] hover:bg-[#0e639c] text-[#d4d4d4] px-2 py-0.5 rounded text-[10px]" 
                      onclick="randomizeCells('${name}')">랜덤</button>
            </div>
          </div>
          <div id="param-grid-${name}" class="grid gap-1.5"></div>
        </div>
      </div>
    `;
    })
    .join("");

  // 이벤트 리스너
  Object.keys(shaderParams).forEach((name) => {
    const slider = document.getElementById(`slider-${name}`);
    const input = document.getElementById(`input-${name}`);
    const display = document.getElementById(`value-${name}`);

    const updateValue = (value) => {
      value = parseFloat(value);
      if (!isNaN(value)) {
        const p = shaderParams[name];
        value = Math.max(p.min, Math.min(p.max, value));
        shaderParams[name].value = value;
        slider.value = value;
        input.value = value;
        display.textContent = value.toFixed(3);
      }
    };

    slider.addEventListener("input", (e) => updateValue(e.target.value));
    input.addEventListener("input", (e) => updateValue(e.target.value));
  });
}

function resetParam(name) {
  if (shaderParams[name]) {
    const defaultVal = shaderParams[name].default;
    shaderParams[name].value = defaultVal;
    document.getElementById(`slider-${name}`).value = defaultVal;
    document.getElementById(`input-${name}`).value = defaultVal;
    document.getElementById(`value-${name}`).textContent =
      defaultVal.toFixed(3);
  }
}

function toggleParamsPanel() {
  const content = document.getElementById("params-content");
  const toggleBtn = document.querySelector(".params-toggle");
  paramsPanelMinimized = !paramsPanelMinimized;
  content.style.display = paramsPanelMinimized ? "none" : "block";
  toggleBtn.textContent = paramsPanelMinimized ? "+" : "−";
}

// 파라미터 변이 기능
function toggleParamVariation(name) {
  const panel = document.getElementById(`variation-${name}`);
  const isHidden = panel.classList.contains("hidden");

  panel.classList.toggle("hidden");

  if (isHidden) {
    // 패널을 열 때 그리드 생성
    updateParamGrid(name);
  }
}

function updateParamGrid(name) {
  const grid = document.getElementById(`param-grid-${name}`);
  const totalCells = gridCols * gridRows;

  // 초기화: 기존 값이 없으면 기본값으로 채움
  if (!cellParamVariations[name]) {
    cellParamVariations[name] = {
      values: Array(totalCells).fill(shaderParams[name].value),
    };
  } else if (cellParamVariations[name].values.length !== totalCells) {
    // 그리드 크기가 변경된 경우
    const newValues = [];
    for (let i = 0; i < totalCells; i++) {
      newValues.push(
        cellParamVariations[name].values[i] ?? shaderParams[name].value
      );
    }
    cellParamVariations[name].values = newValues;
  }

  grid.style.gridTemplateColumns = `repeat(${gridCols}, 1fr)`;
  grid.innerHTML = "";

  // 상단부터 하단으로 (시간 오프셋과 동일한 순서)
  for (let row = gridRows - 1; row >= 0; row--) {
    for (let col = 0; col < gridCols; col++) {
      const index = row * gridCols + col;
      const param = shaderParams[name];

      const div = document.createElement("div");
      div.className = "flex flex-col gap-1 items-center";
      div.innerHTML = `
        <label class="text-[10px] text-gray-400">[${row},${col}]</label>
        <input type="number" 
               class="w-full bg-[#3c3c3c] text-[#d4d4d4] border border-[#555] px-1.5 py-1 rounded text-xs text-center"
               value="${cellParamVariations[name].values[index].toFixed(3)}" 
               step="${param.step}" 
               min="${param.min}" 
               max="${param.max}"
               onchange="updateCellParam('${name}', ${index}, this.value)">
      `;
      grid.appendChild(div);
    }
  }

  // 버튼 활성화 표시
  const btn = document.querySelector(
    `button[onclick="toggleParamVariation('${name}')"]`
  );
  btn.classList.remove("bg-[#3c3c3c]");
  btn.classList.add("bg-[#4ec9b0]");
}

function updateCellParam(name, index, value) {
  value = parseFloat(value);
  if (!isNaN(value)) {
    const param = shaderParams[name];
    value = Math.max(param.min, Math.min(param.max, value));
    cellParamVariations[name].values[index] = value;
  }
}

function fillAllCells(name) {
  const baseValue = shaderParams[name].value;
  const totalCells = gridCols * gridRows;

  if (!cellParamVariations[name]) {
    cellParamVariations[name] = { values: [] };
  }

  cellParamVariations[name].values = Array(totalCells).fill(baseValue);
  updateParamGrid(name);
}

function randomizeCells(name) {
  const param = shaderParams[name];
  const totalCells = gridCols * gridRows;

  if (!cellParamVariations[name]) {
    cellParamVariations[name] = { values: [] };
  }

  cellParamVariations[name].values = Array(totalCells)
    .fill(0)
    .map(() => param.min + Math.random() * (param.max - param.min));

  updateParamGrid(name);
}

function updateVariationMode(name, mode) {
  // 모드 변경 시 처리 (사용 안 함)
}

function applyVariation(name) {
  // 사용 안 함 - 그리드 입력 방식으로 변경
}

// 쉐이더 컴파일
function compileShader(source, type, context = gl) {
  const shader = context.createShader(type);
  context.shaderSource(shader, source);
  context.compileShader(shader);
  if (!context.getShaderParameter(shader, context.COMPILE_STATUS)) {
    const error = context.getShaderInfoLog(shader);
    context.deleteShader(shader);
    throw new Error(error);
  }
  return shader;
}

function createProgram(userFragmentCode, context = gl, forGrid = false) {
  const vertexShader = compileShader(
    vertexShaderSource,
    context.VERTEX_SHADER,
    context
  );
  const fragmentShader = compileShader(
    buildFragmentShader(userFragmentCode, forGrid),
    context.FRAGMENT_SHADER,
    context
  );
  const newProgram = context.createProgram();
  context.attachShader(newProgram, vertexShader);
  context.attachShader(newProgram, fragmentShader);
  context.linkProgram(newProgram);
  if (!context.getProgramParameter(newProgram, context.LINK_STATUS)) {
    const error = context.getProgramInfoLog(newProgram);
    context.deleteProgram(newProgram);
    throw new Error(error);
  }
  return newProgram;
}

// 버퍼 생성
const vertices = new Float32Array([-1, -1, 3, -1, -1, 3]);
const buffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

const gridBuffer = gridGl.createBuffer();
gridGl.bindBuffer(gridGl.ARRAY_BUFFER, gridBuffer);
gridGl.bufferData(gridGl.ARRAY_BUFFER, vertices, gridGl.STATIC_DRAW);

// 마우스 이벤트
canvas.addEventListener("mousemove", (e) => {
  const rect = canvas.getBoundingClientRect();
  mouseX = e.clientX - rect.left;
  mouseY = canvas.height - (e.clientY - rect.top);
});
canvas.addEventListener("mousedown", () => (mouseDown = true));
canvas.addEventListener("mouseup", () => (mouseDown = false));

// 시간 오프셋 생성
function generateTimeOffsets() {
  const mode = document.getElementById("offset-mode").value;
  const totalCells = gridCols * gridRows;
  cellTimeOffsets = [];

  for (let i = 0; i < totalCells; i++) {
    if (mode === "random") {
      cellTimeOffsets.push([0, 1, 2][Math.floor(Math.random() * 3)]);
    } else if (mode === "sequential") {
      cellTimeOffsets.push(i % 3);
    } else if (mode === "manual") {
      cellTimeOffsets.push(cellTimeOffsets[i] || 0);
    } else {
      cellTimeOffsets.push(0);
    }
  }
  updateCellOffsetInputs();
}

function updateCellOffsetInputs() {
  const mode = document.getElementById("offset-mode").value;
  const container = document.getElementById("cell-offsets-container");
  const grid = document.getElementById("cell-offsets-grid");

  if (mode === "manual") {
    container.classList.remove("hidden");
    grid.style.gridTemplateColumns = `repeat(${gridCols}, 1fr)`;
    grid.innerHTML = "";

    for (let row = gridRows - 1; row >= 0; row--) {
      for (let col = 0; col < gridCols; col++) {
        const index = row * gridCols + col;
        const div = document.createElement("div");
        div.className = "flex flex-col gap-1 items-center";
        div.innerHTML = `
          <label class="text-[10px] text-gray-400">[${row},${col}]</label>
          <input type="number" class="w-full bg-[#3c3c3c] text-[#d4d4d4] border border-[#555] px-1.5 py-1 rounded text-xs text-center"
                 value="${cellTimeOffsets[index].toFixed(
                   2
                 )}" step="0.1" min="0" max="${loopDuration}"
                 onchange="cellTimeOffsets[${index}] = parseFloat(this.value) || 0">
        `;
        grid.appendChild(div);
      }
    }
  } else {
    container.classList.add("hidden");
  }
}

// 렌더링
function render() {
  const currentTime = (Date.now() - startTime) / 1000.0;

  if (isRecording && autoStopEnabled) {
    const elapsed = currentTime - recordingStartTime;
    if (elapsed >= recordingTargetDuration) stopRecording();
    document.getElementById(
      "record-status"
    ).textContent = `녹화 중... (${elapsed.toFixed(
      1
    )}s / ${recordingTargetDuration.toFixed(1)}s)`;
  }

  if (isGridMode && gridProgram) {
    renderGrid(currentTime);
  } else if (program) {
    renderSingle(currentTime);
  }

  frameCount++;
  const now = Date.now();
  if (now - lastFpsTime >= 1000) {
    document.getElementById("fps-counter").textContent = frameCount;
    frameCount = 0;
    lastFpsTime = now;
  }

  document.getElementById("time-counter").textContent = currentTime.toFixed(2);
  animationId = requestAnimationFrame(render);
}

function renderSingle(currentTime) {
  gl.useProgram(program);
  gl.uniform2f(
    gl.getUniformLocation(program, "iResolution"),
    canvas.width,
    canvas.height
  );
  gl.uniform1f(gl.getUniformLocation(program, "iTime"), currentTime);
  gl.uniform4f(
    gl.getUniformLocation(program, "iMouse"),
    mouseX,
    mouseY,
    mouseDown ? 1 : 0,
    0
  );
  gl.uniform1i(gl.getUniformLocation(program, "iFrame"), frameCount);

  Object.keys(shaderParams).forEach((name) => {
    const loc = gl.getUniformLocation(program, name);
    if (loc !== null) gl.uniform1f(loc, shaderParams[name].value);
  });

  const positionLoc = gl.getAttribLocation(program, "position");
  gl.enableVertexAttribArray(positionLoc);
  gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

function renderGrid(currentTime) {
  gridGl.useProgram(gridProgram);

  gridGl.clearColor(0, 0, 0, 1);
  gridGl.clear(gridGl.COLOR_BUFFER_BIT);

  const positionLoc = gridGl.getAttribLocation(gridProgram, "position");
  gridGl.enableVertexAttribArray(positionLoc);
  gridGl.vertexAttribPointer(positionLoc, 2, gridGl.FLOAT, false, 0, 0);

  let cellIndex = 0;
  for (let row = 0; row < gridRows; row++) {
    for (let col = 0; col < gridCols; col++) {
      // 정수 좌표 사용으로 픽셀 경계 정렬
      const x = Math.floor((col * gridCanvas.width) / gridCols);
      const y = Math.floor((row * gridCanvas.height) / gridRows);
      const w = Math.floor(((col + 1) * gridCanvas.width) / gridCols) - x;
      const h = Math.floor(((row + 1) * gridCanvas.height) / gridRows) - y;

      gridGl.viewport(x, y, w, h);
      gridGl.scissor(x, y, w, h);
      gridGl.enable(gridGl.SCISSOR_TEST);

      const offset = cellTimeOffsets[cellIndex] || 0;
      const adjustedTime = (currentTime + offset) * playbackSpeed;
      let loopTime;
      if (loopMode === "pingpong") {
        const cycleTime = adjustedTime % (loopDuration * 2);
        loopTime =
          cycleTime < loopDuration ? cycleTime : loopDuration * 2 - cycleTime;
      } else {
        loopTime = adjustedTime % loopDuration;
      }

      gridGl.uniform2f(
        gridGl.getUniformLocation(gridProgram, "iResolution"),
        w,
        h
      );
      gridGl.uniform1f(
        gridGl.getUniformLocation(gridProgram, "iTime"),
        loopTime
      );
      gridGl.uniform4f(
        gridGl.getUniformLocation(gridProgram, "iMouse"),
        0,
        0,
        0,
        0
      );
      gridGl.uniform1i(
        gridGl.getUniformLocation(gridProgram, "iFrame"),
        frameCount
      );

      const iOffsetLoc = gridGl.getUniformLocation(gridProgram, "iOffset");
      if (iOffsetLoc !== null) gridGl.uniform2f(iOffsetLoc, x, y);

      // 파라미터 적용 (셀별 변이 포함)
      Object.keys(shaderParams).forEach((name) => {
        const loc = gridGl.getUniformLocation(gridProgram, name);
        if (loc !== null) {
          const cellValue =
            cellParamVariations[name]?.values?.[cellIndex] ??
            shaderParams[name].value;
          gridGl.uniform1f(loc, cellValue);
        }
      });

      gridGl.drawArrays(gridGl.TRIANGLES, 0, 3);
      cellIndex++;
    }
  }

  gridGl.disable(gridGl.SCISSOR_TEST);
  gridGl.viewport(0, 0, gridCanvas.width, gridCanvas.height);
}

// 컴파일 및 실행
function compileAndRun() {
  try {
    updateParameterUI();
    const code = document.getElementById("shader-code").value;
    const newProgram = createProgram(code, gl, false);
    const newGridProgram = createProgram(code, gridGl, true);

    if (program) gl.deleteProgram(program);
    if (gridProgram) gridGl.deleteProgram(gridProgram);

    program = newProgram;
    gridProgram = newGridProgram;
    document.getElementById("error").classList.add("hidden");

    if (!animationId) render();
    autoSaveCurrentCode();
  } catch (error) {
    const errorDiv = document.getElementById("error");
    errorDiv.textContent = "쉐이더 컴파일 오류:\n" + error.message;
    errorDiv.classList.remove("hidden");
  }
}

// LocalStorage
const STORAGE_KEY = "shader-codes";
let currentCardId = null;

function getSavedCodes() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch (e) {
    return [];
  }
}

function setSavedCodes(codes) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(codes));
  } catch (e) {}
}

function autoSaveCurrentCode() {
  const codes = getSavedCodes();
  const code = document.getElementById("shader-code").value;

  if (currentCardId) {
    const index = codes.findIndex((c) => c.id === currentCardId);
    if (index !== -1) {
      codes[index].code = code;
      codes[index].date = new Date().toISOString();
      setSavedCodes(codes);
      renderCards();
      return;
    }
  }

  const newCode = {
    id: Date.now(),
    name: `Shader ${
      new Date().getMonth() + 1
    }/${new Date().getDate()} ${new Date().getHours()}:${String(
      new Date().getMinutes()
    ).padStart(2, "0")}`,
    code,
    date: new Date().toISOString(),
  };

  codes.push(newCode);
  setSavedCodes(codes);
  currentCardId = newCode.id;
  renderCards();
}

function renderCards() {
  const codes = getSavedCodes().sort((a, b) => b.id - a.id);
  const slider = document.getElementById("cards-slider");

  slider.innerHTML =
    codes
      .map(
        (item) => `
    <div class="inline-block w-40 h-30 bg-[#1e1e1e] border-2 ${
      item.id === currentCardId ? "border-[#4ec9b0]" : "border-[#3c3c3c]"
    } rounded-lg p-3 cursor-pointer transition-all hover:border-[#0e639c] hover:-translate-y-0.5 relative" onclick="loadCard(${
          item.id
        })">
      <button class="hidden absolute top-1 right-1 bg-red-600/90 hover:bg-red-700 text-white border-0 rounded w-5 h-5 text-xs leading-none" onclick="event.stopPropagation(); deleteCard(${
        item.id
      })">×</button>
      <div class="w-full h-15 bg-black rounded mb-2"></div>
      <div class="text-xs truncate mb-1">${item.name}</div>
      <div class="text-[10px] text-gray-400">${formatDate(item.date)}</div>
    </div>
  `
      )
      .join("") +
    `
    <div class="inline-block w-40 h-30 border-2 border-dashed border-[#555] rounded-lg flex flex-col items-center justify-center cursor-pointer hover:border-[#0e639c] text-gray-400 hover:text-[#d4d4d4]" onclick="createNewCard()">
      <div class="text-3xl mb-1">+</div>
      <div class="text-xs">새 쉐이더</div>
    </div>
  `;
}

function loadCard(id) {
  const code = getSavedCodes().find((c) => c.id === id);
  if (code) {
    document.getElementById("shader-code").value = code.code;
    currentCardId = id;
    renderCards();
    compileAndRun();
  }
}

function deleteCard(id) {
  if (!confirm("삭제하시겠습니까?")) return;
  const codes = getSavedCodes().filter((c) => c.id !== id);
  setSavedCodes(codes);
  if (currentCardId === id) {
    if (codes.length > 0) loadCard(codes[0].id);
    else {
      currentCardId = null;
      document.getElementById("shader-code").value = "";
    }
  }
  renderCards();
}

function createNewCard() {
  const newCode = {
    id: Date.now(),
    name: `Shader ${new Date().getMonth() + 1}/${new Date().getDate()}`,
    code: "// 새 쉐이더",
    date: new Date().toISOString(),
  };
  setSavedCodes([...getSavedCodes(), newCode]);
  loadCard(newCode.id);
}

function formatDate(iso) {
  const diff = Date.now() - new Date(iso);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "방금 전";
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(diff / 3600000);
  if (hours < 24) return `${hours}시간 전`;
  return new Date(iso).toLocaleDateString("ko-KR");
}

// 녹화
function startRecordingAt(startFrom) {
  const currentTime = (Date.now() - startTime) / 1000.0;

  autoStopEnabled = document.getElementById("auto-stop").checked;
  recordingTargetDuration = parseFloat(
    document.getElementById("record-duration").value
  );

  if (Math.abs(currentTime - startFrom) > 0.1) {
    startTime = Date.now() - startFrom * 1000;
    document.getElementById("record-status").textContent = `${startFrom.toFixed(
      1
    )}초로 이동 중...`;

    setTimeout(() => {
      startRecording();
    }, 100);
  } else {
    startRecording();
  }
}

function startRecording() {
  const fps = parseInt(document.getElementById("fps").value);
  const bitrate = parseInt(document.getElementById("bitrate").value);
  const targetCanvas = isGridMode ? gridCanvas : canvas;
  const stream = targetCanvas.captureStream(fps);

  recordedChunks = [];
  recordingStartTime = (Date.now() - startTime) / 1000.0;

  let options = {
    mimeType: "video/mp4;codecs=avc1",
    videoBitsPerSecond: bitrate,
  };
  let ext = "mp4",
    mime = "video/mp4";

  if (!MediaRecorder.isTypeSupported(options.mimeType)) {
    options.mimeType = "video/webm;codecs=vp9";
    ext = "webm";
    mime = "video/webm";
  }

  mediaRecorder = new MediaRecorder(stream, options);
  mediaRecorder.ondataavailable = (e) => {
    if (e.data?.size > 0) recordedChunks.push(e.data);
  };
  mediaRecorder.onstop = () => {
    const blob = new Blob(recordedChunks, { type: mime });
    const url = URL.createObjectURL(blob);
    const downloadBtn = document.getElementById("download-btn");
    downloadBtn.classList.remove("hidden");
    downloadBtn.onclick = () => {
      const a = document.createElement("a");
      a.href = url;
      a.download = `shader-${Date.now()}.${ext}`;
      a.click();
    };
    document.getElementById("record-status").textContent = `완료 (${(
      blob.size /
      1024 /
      1024
    ).toFixed(2)}MB)`;
  };

  mediaRecorder.start(1000);
  isRecording = true;
  document.getElementById("record-btn").textContent = "녹화 중지";
  document.getElementById("record-btn").classList.add("bg-red-600");
}

function stopRecording() {
  if (mediaRecorder?.state !== "inactive") mediaRecorder.stop();
  isRecording = false;
  document.getElementById("record-btn").textContent = "녹화 시작";
  document.getElementById("record-btn").classList.remove("bg-red-600");
}

// 이벤트 리스너
document.getElementById("compile-btn").addEventListener("click", compileAndRun);
document.getElementById("reset-btn").addEventListener("click", () => {
  startTime = Date.now();
  frameCount = 0;
});
document.getElementById("apply-res-btn").addEventListener("click", () => {
  setResolution(
    parseInt(document.getElementById("width").value),
    parseInt(document.getElementById("height").value)
  );
});

document.getElementById("toggle-grid-btn").addEventListener("click", () => {
  isGridMode = !isGridMode;
  const btn = document.getElementById("toggle-grid-btn");
  const gridSettings = document.getElementById("grid-settings");

  if (isGridMode) {
    btn.textContent = "단일 모드";
    btn.classList.add("bg-[#4ec9b0]");
    canvas.classList.add("hidden");
    gridCanvas.classList.remove("hidden");
    gridSettings.classList.remove("hidden");
    document.getElementById(
      "mode-info"
    ).textContent = `그리드 ${gridCols}×${gridRows}`;
    generateTimeOffsets();
  } else {
    btn.textContent = "그리드 모드";
    btn.classList.remove("bg-[#4ec9b0]");
    canvas.classList.remove("hidden");
    gridCanvas.classList.add("hidden");
    gridSettings.classList.add("hidden");
    document.getElementById("mode-info").textContent = "단일";
  }
});

document.getElementById("grid-cols").addEventListener("change", (e) => {
  gridCols = parseInt(e.target.value);
  generateTimeOffsets();
  // 파라미터 그리드도 업데이트
  Object.keys(cellParamVariations).forEach((name) => {
    if (
      !document
        .getElementById(`variation-${name}`)
        ?.classList.contains("hidden")
    ) {
      updateParamGrid(name);
    }
  });
});
document.getElementById("grid-rows").addEventListener("change", (e) => {
  gridRows = parseInt(e.target.value);
  generateTimeOffsets();
  // 파라미터 그리드도 업데이트
  Object.keys(cellParamVariations).forEach((name) => {
    if (
      !document
        .getElementById(`variation-${name}`)
        ?.classList.contains("hidden")
    ) {
      updateParamGrid(name);
    }
  });
});
document.getElementById("loop-duration").addEventListener("change", (e) => {
  loopDuration = parseFloat(e.target.value);
});
document.getElementById("playback-speed").addEventListener("input", (e) => {
  playbackSpeed = parseFloat(e.target.value) || 1.0;
});
document.getElementById("loop-mode").addEventListener("change", (e) => {
  loopMode = e.target.value;
});
document
  .getElementById("offset-mode")
  .addEventListener("change", generateTimeOffsets);
document
  .getElementById("regenerate-offsets-btn")
  .addEventListener("click", generateTimeOffsets);

document.getElementById("record-btn").addEventListener("click", () => {
  if (!isRecording) {
    const startFrom = parseFloat(document.getElementById("record-start").value);
    startRecordingAt(startFrom);
  } else {
    stopRecording();
  }
});

document.getElementById("record-reset-btn").addEventListener("click", () => {
  startTime = Date.now();
  frameCount = 0;
  startRecordingAt(0);
});

document.getElementById("shader-code").addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key === "Enter") {
    e.preventDefault();
    compileAndRun();
  }
  if (e.key === "Tab") {
    e.preventDefault();
    const start = e.target.selectionStart;
    const end = e.target.selectionEnd;
    e.target.value =
      e.target.value.substring(0, start) +
      "    " +
      e.target.value.substring(end);
    e.target.selectionStart = e.target.selectionEnd = start + 4;
  }
});

// 초기화
generateTimeOffsets();
renderCards();
const savedCodes = getSavedCodes();
if (savedCodes.length > 0) {
  loadCard(savedCodes[savedCodes.length - 1].id);
} else {
  compileAndRun();
}
