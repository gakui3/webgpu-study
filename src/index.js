import SimpleVert from "./shaders/vert.wgsl?raw";
import SimpleFrag from "./shaders/frag.wgsl?raw";
import SimpleCompute from "./shaders/compute.wgsl?raw";

const GRID_SIZE = 256;
const UPDATE_INTERVAL = 33; // 33ms = 30fps
const WORKGROUP_SIZE = 8;

const canvas = document.querySelector("canvas");

// webgpuが使えるかどうかを確認
if (!navigator.gpu) {
  throw new Error("WebGPU not supported on this browser.");
}

// GPUAdapterをリクエスト
// GpuAdapterとは、GPUの機能を提供するためのインターフェース
const adapter = await navigator.gpu.requestAdapter();
if (!adapter) {
  throw new Error("No appropriate GPUAdapter found.");
}

// GPUDeviceをリクエスト
// GPUDeviceは、GPUの機能を直接利用するためのインターフェース
const device = await adapter.requestDevice();

const context = canvas.getContext("webgpu");
// GPUDeviceを使って、GPUコンテキストを設定
const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
context.configure({
  device: device,
  format: canvasFormat,
});

// 頂点の位置を定義
const vertices = new Float32Array([
  -0.8, -0.8, 0.8, -0.8, 0.8, 0.8,

  -0.8, -0.8, 0.8, 0.8, -0.8, 0.8,
]);
const vertexBuffer = device.createBuffer({
  label: "Cell vertices",
  size: vertices.byteLength,
  usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
});
device.queue.writeBuffer(vertexBuffer, 0, vertices);

// 頂点バッファのレイアウトを定義
const vertexBufferLayout = {
  arrayStride: 8,
  attributes: [
    {
      format: "float32x2",
      offset: 0,
      shaderLocation: 0,
    },
  ],
};

// セルの状態を表すバッファを作成しています。
const bindGroupLayout = device.createBindGroupLayout({
  label: "Cell Bind Group Layout",
  entries: [
    {
      binding: 0,
      visibility: GPUShaderStage.VERTEX | GPUShaderStage.COMPUTE,
      buffer: {}, // グリッドのユニフォームバッファ
    },
    {
      binding: 1,
      visibility: GPUShaderStage.VERTEX | GPUShaderStage.COMPUTE,
      buffer: {type: "read-only-storage"}, // セルの状態入力バッファ
    },
    {
      binding: 2,
      visibility: GPUShaderStage.COMPUTE,
      buffer: {type: "storage"}, // セルの状態出力バッファ
    },
  ],
});

const pipelineLayout = device.createPipelineLayout({
  label: "Cell Pipeline Layout",
  bindGroupLayouts: [bindGroupLayout],
});

//ここでは、セルを描画するシェーダを作成しています。
const vertexShaderModule = device.createShaderModule({
  label: "Vertex Shader",
  code: SimpleVert,
});

const fragmentShaderModule = device.createShaderModule({
  label: "Fragment Shader",
  code: SimpleFrag,
});

// セルを描画するパイプラインを作成します。
const cellPipeline = device.createRenderPipeline({
  label: "Cell pipeline",
  layout: pipelineLayout,
  vertex: {
    module: vertexShaderModule,
    entryPoint: "vertexMain",
    buffers: [vertexBufferLayout],
  },
  fragment: {
    module: fragmentShaderModule,
    entryPoint: "fragmentMain",
    targets: [
      {
        format: canvasFormat,
      },
    ],
  },
});

// ライフゲームのシミュレーションを処理するコンピュートシェーダを作成
const simulationShaderModule = device.createShaderModule({
  label: "Life simulation shader",
  code: SimpleCompute,
});

// ゲームの状態を更新するコンピュートパイプラインを作成します。
const simulationPipeline = device.createComputePipeline({
  label: "Simulation pipeline",
  layout: pipelineLayout,
  compute: {
    module: simulationShaderModule,
    entryPoint: "computeMain",
  },
});

// グリッドを表すユニフォームバッファを作成します。
const uniformArray = new Float32Array([GRID_SIZE, GRID_SIZE]);
const uniformBuffer = device.createBuffer({
  label: "Grid Uniforms",
  size: uniformArray.byteLength,
  usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
});
device.queue.writeBuffer(uniformBuffer, 0, uniformArray);

// 各セルのアクティブな状態を表す配列を作成します。
const cellStateArray = new Uint32Array(GRID_SIZE * GRID_SIZE);

// セルの状態を保持するための2つのストレージバッファを作成します。
const cellStateStorage = [
  device.createBuffer({
    label: "Cell State A",
    size: cellStateArray.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  }),
  device.createBuffer({
    label: "Cell State B",
    size: cellStateArray.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  }),
];

// 各セルをランダムな状態に設定し、その後、JavaScript配列をストレージバッファにコピーします。
for (let i = 0; i < cellStateArray.length; ++i) {
  cellStateArray[i] = Math.random() > 0.6 ? 1 : 0;
}
device.queue.writeBuffer(cellStateStorage[0], 0, cellStateArray);

// グリッドのユニフォームをパイプラインに渡すためのバインドグループを作成します。
const bindGroups = [
  device.createBindGroup({
    label: "Cell renderer bind group A",
    layout: bindGroupLayout,
    entries: [
      {
        binding: 0,
        resource: {buffer: uniformBuffer},
      },
      {
        binding: 1,
        resource: {buffer: cellStateStorage[0]},
      },
      {
        binding: 2,
        resource: {buffer: cellStateStorage[1]},
      },
    ],
  }),
  device.createBindGroup({
    label: "Cell renderer bind group B",
    layout: bindGroupLayout,
    entries: [
      {
        binding: 0,
        resource: {buffer: uniformBuffer},
      },
      {
        binding: 1,
        resource: {buffer: cellStateStorage[1]},
      },
      {
        binding: 2,
        resource: {buffer: cellStateStorage[0]},
      },
    ],
  }),
];

let step = 0;
function updateGrid() {
  const encoder = device.createCommandEncoder();

  // Start a compute pass
  const computePass = encoder.beginComputePass();

  computePass.setPipeline(simulationPipeline);
  computePass.setBindGroup(0, bindGroups[step % 2]);
  const workgroupCount = Math.ceil(GRID_SIZE / WORKGROUP_SIZE);
  computePass.dispatchWorkgroups(workgroupCount, workgroupCount);
  computePass.end();

  step++; // Updated!

  // レンダーパスを開始します。
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: context.getCurrentTexture().createView(),
        loadOp: "clear",
        clearValue: {r: 0, g: 0, b: 0.4, a: 1.0},
        storeOp: "store",
      },
    ],
  });

  // グリッドを描画します。
  pass.setPipeline(cellPipeline);
  pass.setBindGroup(0, bindGroups[step % 2]); // Updated!
  pass.setVertexBuffer(0, vertexBuffer);
  pass.draw(vertices.length / 2, GRID_SIZE * GRID_SIZE);

  // レンダーパスを終了し、コマンドバッファを送信します。
  pass.end();
  device.queue.submit([encoder.finish()]);
}
setInterval(updateGrid, UPDATE_INTERVAL);
