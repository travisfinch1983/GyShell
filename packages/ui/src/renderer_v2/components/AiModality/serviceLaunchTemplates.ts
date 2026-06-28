// Ported verbatim from ProxLab public/js/modules/ai.js — TTS + Imagegen launch templates.
/* eslint-disable */
// @ts-nocheck
export const TTS_LAUNCH_TEMPLATES: Record<string, any> = {
    alltalk: {
      defaultPort: 7851,
      endpointSuffix: '',
      // AllTalk V2: FastAPI + embedded uvicorn, config from confignew.json
      // API port in api_def.api_port_number, IP in api_def.api_legacy_ip_address
      // Gradio UI on gradio_port_number (default 7852)
      buildCommand(port) {
        return [
          `# Patch confignew.json for 0.0.0.0:${port}`,
          `/opt/conda/envs/alltalk/bin/python3 -c "`,
          `import json, pathlib`,
          `p = pathlib.Path('/opt/alltalk/confignew.json')`,
          `c = json.loads(p.read_text())`,
          `c['api_def']['api_legacy_ip_address'] = '0.0.0.0'`,
          `c['api_def']['api_port_number'] = ${port}`,
          `c['gradio_port_number'] = ${port + 1}`,
          `p.write_text(json.dumps(c, indent=2))`,
          `"`,
          '',
          `# Launch AllTalk V2 (API on :${port}, Gradio on :${port + 1})`,
          'export CUDA_HOME=/opt/conda/envs/alltalk',
          'cd /opt/alltalk &&',
          `/opt/conda/envs/alltalk/bin/python script.py`,
        ].join('\n');
      },
    },
    f5tts: {
      defaultPort: 7860,
      endpointSuffix: '',
      // F5-TTS Gradio: --host and --port CLI flags work
      buildCommand(port) {
        return [
          '/opt/conda/envs/f5tts/bin/f5-tts_infer-gradio \\',
          `  --host 0.0.0.0 --port ${port}`,
        ].join('\n');
      },
    },
    'proxlab-tts': {
      defaultPort: 8880,
      endpointSuffix: '/v1',
      // Proxlab TTS: Chatterbox-Turbo with OpenAI-compatible API
      buildCommand(port) {
        return [
          '/opt/conda/envs/chatterbox-tts/bin/python \\',
          `  /opt/proxlab-tts/server.py \\`,
          `  --host 0.0.0.0 --port ${port} \\`,
          '  --voices /root/voices',
        ].join('\n');
      },
    },
    dramabox: {
      defaultPort: 8885,
      endpointSuffix: '/v1',
      // Dramabox theatrical TTS — diffusion DiT + Gemma 3 12B text encoder.
      // serve.sh wraps server.py with all model/voice paths baked in; the
      // only knobs the launch tab exposes are GPU and port.
      buildCommand(port, model, gpuIndex) {
        const gpuPrefix = (typeof gpuIndex === 'number' && gpuIndex >= 0)
          ? `CUDA_VISIBLE_DEVICES=${gpuIndex} `
          : '';
        return [
          `${gpuPrefix}/opt/dramabox/serve.sh \\`,
          `  --port ${port}`,
        ].join('\n');
      },
    },
    's2-pro': {
      defaultPort: 8882,
      endpointSuffix: '/v1',
      // Fish-Audio S2-Pro via sglang-omni. Single-shape OpenAI-compat
      // server — no model variants to pick (the model IS the model),
      // no separate backend choice. serve.sh resolves the local
      // /tts/models/Fish-Audio/S2-Pro-Safetensors path so launches
      // don't trigger HuggingFace downloads.
      buildCommand(port, model, gpuIndex) {
        const gpuPrefix = (typeof gpuIndex === 'number' && gpuIndex >= 0)
          ? `CUDA_VISIBLE_DEVICES=${gpuIndex} `
          : '';
        return [
          `${gpuPrefix}/opt/s2-pro/serve.sh \\`,
          `  --port ${port}`,
        ].join('\n');
      },
    },
    'qwen-tts': {
      defaultPort: 8881,
      endpointSuffix: '/v1',
      // Qwen3-TTS via pasky/Qwen3-TTS-Openai-Fastapi (wraps qwen_tts).
      // Variant picker drives the model dropdown (default 1.7B-Base —
      // all-rounder w/ 3-sec voice cloning). Backend picker selects
      // official (pure PyTorch, simpler) vs vllm_omni (PagedAttention +
      // flash-attn, faster first-audio latency, requires the [vllm]
      // extra installed). serve.sh resolves a local /tts/models path
      // so launches don't hit HuggingFace.
      defaultModel: 'Qwen3-TTS-12Hz-1.7B-Base',
      models: [
        { id: 'Qwen3-TTS-12Hz-1.7B-Base',         label: '1.7B Base — cloning, all-rounder' },
        { id: 'Qwen3-TTS-12Hz-0.6B-Base',         label: '0.6B Base — cloning, lightweight' },
        { id: 'Qwen3-TTS-12Hz-1.7B-CustomVoice',  label: '1.7B CustomVoice — 9 presets + style instructions' },
        { id: 'Qwen3-TTS-12Hz-1.7B-VoiceDesign',  label: '1.7B VoiceDesign — text-described voice synthesis' },
      ],
      defaultBackend: 'vllm_omni',
      backends: [
        { id: 'vllm_omni', label: 'vllm_omni — PagedAttention + flash-attn (faster)' },
        { id: 'official',  label: 'official — pure PyTorch transformers (simpler)' },
      ],
      buildCommand(port, model, gpuIndex, backend) {
        const variant = model || 'Qwen3-TTS-12Hz-1.7B-Base';
        const be = backend || 'vllm_omni';
        const gpuPrefix = (typeof gpuIndex === 'number' && gpuIndex >= 0)
          ? `CUDA_VISIBLE_DEVICES=${gpuIndex} `
          : '';
        return [
          `${gpuPrefix}/opt/qwen-tts/serve.sh \\`,
          `  --port ${port} \\`,
          `  --variant ${variant} \\`,
          `  --backend ${be}`,
        ].join('\n');
      },
    },
    kokoro: {
      defaultPort: 8880,
      endpointSuffix: '/v1',
      // Kokoro: uvicorn with --host/--port, must cd to /opt/kokoro
      buildCommand(port) {
        return [
          'cd /opt/kokoro &&',
          '/opt/conda/envs/kokoro/bin/python -m uvicorn api.src.main:app \\',
          `  --host 0.0.0.0 --port ${port}`,
        ].join('\n');
      },
    },
    'openedai-speech': {
      defaultPort: 8000,
      endpointSuffix: '/v1',
      // OpenedAI Speech: --host/--port CLI flags work, default is 0.0.0.0
      buildCommand(port) {
        return [
          '/opt/conda/envs/openedai-speech/bin/python \\',
          `  /opt/openedai-speech/speech.py --host 0.0.0.0 --port ${port}`,
        ].join('\n');
      },
    },
    'tts-webui': {
      defaultPort: 7770,
      endpointSuffix: '',
      // TTS-WebUI: NO CLI flags for host/port. Must patch config.json then launch.
      // Gradio listens on server_port (default 7770), React UI on REACT_UI_PORT (3000).
      buildCommand(port) {
        return [
          `# Patch config.json for 0.0.0.0:${port}`,
          `/opt/conda/envs/tts-webui/bin/python3 -c "`,
          `import json, pathlib`,
          `p = pathlib.Path('/opt/tts-webui/config.json')`,
          `c = json.loads(p.read_text())`,
          `c['gradio_interface_options']['server_name'] = '0.0.0.0'`,
          `c['gradio_interface_options']['server_port'] = ${port}`,
          `p.write_text(json.dumps(c, indent=2))`,
          `"`,
          '',
          `# Launch (React UI on :3000, Gradio on :${port})`,
          'cd /opt/tts-webui &&',
          `/opt/conda/envs/tts-webui/bin/python server.py`,
        ].join('\n');
      },
    },
    piper: {
      defaultPort: 5000,
      endpointSuffix: '',
      // Piper TTS: built-in HTTP server, --host/--port flags work
      buildCommand(port) {
        return [
          '/opt/conda/envs/piper/bin/python -m piper.http_server \\',
          `  --data-dir /opt/piper/voices \\`,
          `  -m en_US-lessac-medium \\`,
          `  --host 0.0.0.0 --port ${port}`,
        ].join('\n');
      },
    },
    'faster-whisper': {
      defaultPort: 8079,
      endpointSuffix: '/v1',
      models: [
        { id: 'large-v3-turbo', label: 'Large V3 Turbo (809M)' },
        { id: 'large-v3',       label: 'Large V3 (1.5B)' },
        { id: 'large-v2',       label: 'Large V2 (1.5B)' },
        { id: 'medium',         label: 'Medium (769M)' },
        { id: 'small',          label: 'Small (244M)' },
        { id: 'base',           label: 'Base (74M)' },
        { id: 'tiny',           label: 'Tiny (39M)' },
      ],
      defaultModel: 'large-v3-turbo',
      // Faster-Whisper: custom FastAPI server with --host/--port/--model flags
      buildCommand(port, model) {
        return [
          'export LD_LIBRARY_PATH=/usr/local/cuda/lib64:$LD_LIBRARY_PATH',
          '/opt/conda/envs/faster-whisper/bin/python \\',
          `  /opt/faster-whisper/server.py \\`,
          `  --model ${model || 'large-v3-turbo'} --host 0.0.0.0 --port ${port}`,
        ].join('\n');
      },
    },
}

export const IMAGE_LAUNCH_TEMPLATES: Record<string, any> = {
    comfyui: {
      defaultPort: 8188,
      multiGpu: true,
      buildCommand(port, opts) {
        // The model-cache RAM disk (/model-cache/imagegen/...) is tmpfs on the
        // host. It clears on host reboot, so we re-create the expected subdir
        // skeleton on every launch. extra_model_paths.yaml has a model-cache:
        // root pointing here so ComfyUI scans both /imagegen/ and /model-cache/
        // imagegen/ for assets, with cached files winning by path order.
        // ComfyUI reads extra_model_paths.yaml only at startup — the cat >>
        // append below takes effect on the NEXT launch if the section is
        // missing. Idempotent: grep -q skips the append if already present, so
        // manual edits to add more roots are not clobbered.
        //
        // --enable-manager activates the comfyui_manager pip package
        // (separate from the legacy git-cloned custom_nodes/ComfyUI-Manager).
        // ComfyUI core gates the in-frontend "install missing nodes" UI
        // behind this flag as of v0.3+. Requires `pip install -r
        // /opt/comfyui/manager_requirements.txt` in the conda env, and
        // any custom_nodes/ComfyUI-Manager dir must be removed (security
        // policy blocks legacy + pip-pkg loading simultaneously).
        const cacheSubdirs = 'checkpoints ckpts loras lycoris vae vae-approx taesd clip-vision ' +
          'controlnet t2i-adapter diffusion-models text-encoders embeddings ' +
          'upscale-models latent_upscale_models diffusers gligen style-models ' +
          'photomaker configs audio-encoders ipadapter llm tts step-audio clip-models';
        return [
          'export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True',
          '',
          '# Pre-create /model-cache/imagegen tmpfs skeleton (cleared on host reboot)',
          `for sub in ${cacheSubdirs}; do`,
          '    mkdir -p "/model-cache/imagegen/$sub" 2>/dev/null || true',
          'done',
          '',
          '# Ensure ComfyUI extra_model_paths.yaml has the model-cache: root.',
          "if ! grep -q '^model-cache:' /opt/comfyui/extra_model_paths.yaml 2>/dev/null; then",
          "  cat >> /opt/comfyui/extra_model_paths.yaml <<'YAML_EOF'",
          '',
          'model-cache:',
          '    base_path: /model-cache/imagegen',
          '    checkpoints: |',
          '        checkpoints',
          '        ckpts',
          '    loras: |',
          '        loras',
          '        lycoris',
          '    vae: vae',
          '    vae_approx: |',
          '        vae-approx',
          '        taesd',
          '    clip_vision: clip-vision',
          '    controlnet: |',
          '        controlnet',
          '        t2i-adapter',
          '    diffusion_models: diffusion-models',
          '    text_encoders: text-encoders',
          '    unet: diffusion-models',
          '    embeddings: embeddings',
          '    upscale_models: upscale-models',
          '    latent_upscale_models: latent_upscale_models',
          '    diffusers: diffusers',
          '    gligen: gligen',
          '    style_models: style-models',
          '    photomaker: photomaker',
          '    configs: configs',
          '    audio_encoders: audio-encoders',
          '    ipadapter: ipadapter',
          '    LLM: llm',
          '    TTS: tts',
          '    step_audio: step-audio',
          '    clip_models: clip-models',
          'YAML_EOF',
          'fi',
          '',
          'cd /opt/comfyui &&',
          `/opt/conda/envs/comfyui/bin/python main.py \\`,
          `  --listen 0.0.0.0 --port ${port} \\`,
          `  --enable-manager`,
        ].join('\n');
      },
    },
    sdnext: {
      defaultPort: 7860,
      multiGpu: false,
      buildCommand(port) {
        // --skip-all bypasses installer.py's auto-upgrade of diffusers/
        // transformers/accelerate on every launch. Required on Volta hosts
        // where torch is pinned to 2.4.1+cu124 — without it sdnext re-pulls
        // bleeding-edge deps that need torch 2.5+ and breaks at startup with
        // schema/import errors.
        //
        // PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True switches PyTorch's
        // CUDA memory allocator to virtual-address-backed segments that grow
        // on demand, reducing fragmentation. Helps with diffusion workloads
        // that cycle through large allocations of varying sizes (esp. hires
        // upscale passes). Net win for image gen — no downsides on this stack.
        return [
          'export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True',
          'cd /opt/sdnext &&',
          `/opt/conda/envs/sdnext/bin/python launch.py \\`,
          `  --skip-all --listen --port ${port}`,
        ].join('\n');
      },
    },
    fooocus: {
      defaultPort: 7865,
      multiGpu: false,
      buildCommand(port) {
        return [
          'export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True',
          'cd /opt/fooocus &&',
          `/opt/conda/envs/fooocus/bin/python entry_with_update.py \\`,
          `  --listen 0.0.0.0 --port ${port}`,
        ].join('\n');
      },
    },
    invokeai: {
      defaultPort: 9090,
      multiGpu: false,
      buildCommand(port) {
        return [
          'export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True',
          'export INVOKEAI_ROOT=/opt/invokeai',
          `/opt/conda/envs/invokeai/bin/invokeai-web \\`,
          `  --host 0.0.0.0 --port ${port}`,
        ].join('\n');
      },
    },
    // Training — expandable_segments helps especially here: gradient buffers
    // + activation checkpoints + variable batch shapes between fwd/bwd cycles
    // are exactly the workload pattern the new allocator targets.
}

// ─── Command builders (ported verbatim from ProxLab) ───
export function buildTtsLaunchCommand(providerId, port, model, gpuIndex, backend) {
  const template = TTS_LAUNCH_TEMPLATES[providerId]
  if (!template || !template.buildCommand) return ''
  const cmd = template.buildCommand(port, model || template.defaultModel, gpuIndex, backend || template.defaultBackend)
  const envLines = ['export CUDA_DEVICE_ORDER=PCI_BUS_ID']
  if (gpuIndex !== undefined && gpuIndex !== null && gpuIndex !== 'auto') {
    envLines.push(`export CUDA_VISIBLE_DEVICES=${gpuIndex}`)
  }
  return envLines.join('\n') + '\n' + cmd
}
export function buildGenericLaunchCommand(providerId, port, gpuIndices) {
  const template = IMAGE_LAUNCH_TEMPLATES[providerId]
  if (!template || !template.buildCommand) return ''
  const cmd = template.buildCommand(port || template.defaultPort)
  const envLines = ['export CUDA_DEVICE_ORDER=PCI_BUS_ID']
  if (gpuIndices && gpuIndices !== 'auto') {
    envLines.push(`export CUDA_VISIBLE_DEVICES=${gpuIndices}`)
  }
  return envLines.join('\n') + '\n' + cmd
}
