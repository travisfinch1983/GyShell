// Ported verbatim from ProxLab public/js/modules/ai.js — QUANT_TOOLS (quantization scripts).
/* eslint-disable */
// @ts-nocheck
export const QUANT_TOOLS: Record<string, any> = {
    gguf: {
      name: 'GGUF (llama.cpp)',
      description: 'Convert HF models to GGUF format with various quantization levels',
      node: 'px-gpu', // llama.cpp is on CT 177
      vmid: 177,
      quants: ['Q2_K', 'Q3_K_S', 'Q3_K_M', 'Q3_K_L', 'Q4_0', 'Q4_K_S', 'Q4_K_M', 'Q5_0', 'Q5_K_S', 'Q5_K_M', 'Q6_K', 'Q8_0', 'F16', 'F32',
               'IQ1_S', 'IQ1_M', 'IQ2_XXS', 'IQ2_XS', 'IQ2_S', 'IQ2_M', 'IQ3_XXS', 'IQ3_XS', 'IQ3_S', 'IQ3_M', 'IQ4_XS', 'IQ4_NL'],
      buildCommand(modelPath, outputPath, quantType) {
        return [
          '# Step 1: Convert HF model to GGUF (FP16)',
          `cd /opt/llama.cpp &&`,
          `python3 convert_hf_to_gguf.py "${modelPath}" \\`,
          `  --outfile "${outputPath}/model-f16.gguf" --outtype f16`,
          '',
          '# Step 2: Quantize to target format',
          `./llama-quantize "${outputPath}/model-f16.gguf" \\`,
          `  "${outputPath}/model-${quantType}.gguf" ${quantType}`,
        ].join('\n');
      },
    },
    awq: {
      name: 'AWQ (AutoAWQ)',
      description: 'Activation-aware weight quantization — fast inference, small size',
      node: 'px-epyc',
      vmid: 176,
      quants: ['4-bit'],
      buildCommand(modelPath, outputPath, quantType) {
        return [
          `/opt/conda/envs/vllm/bin/python -c "`,
          `from awq import AutoAWQForCausalLM`,
          `from transformers import AutoTokenizer`,
          `model = AutoAWQForCausalLM.from_pretrained('${modelPath}')`,
          `tokenizer = AutoTokenizer.from_pretrained('${modelPath}')`,
          `model.quantize(tokenizer, quant_config={'zero_point': True, 'q_group_size': 128, 'w_bit': 4})`,
          `model.save_quantized('${outputPath}')`,
          `tokenizer.save_pretrained('${outputPath}')`,
          `print('AWQ quantization complete')`,
          `"`,
        ].join('\n');
      },
    },
    gptq: {
      name: 'GPTQ (GPTQModel)',
      description: 'Post-training quantization — widely supported, good quality',
      node: 'px-epyc',
      vmid: 176,
      quants: ['2-bit', '3-bit', '4-bit', '8-bit'],
      buildCommand(modelPath, outputPath, quantType) {
        const bits = parseInt(quantType) || 4;
        return [
          `/opt/conda/envs/vllm/bin/python -c "`,
          `from gptqmodel import GPTQModel`,
          `from transformers import AutoTokenizer`,
          `tokenizer = AutoTokenizer.from_pretrained('${modelPath}')`,
          `model = GPTQModel.load('${modelPath}', quant_config={'bits': ${bits}, 'group_size': 128, 'damp_percent': 0.01})`,
          `model.quantize(tokenizer)`,
          `model.save('${outputPath}')`,
          `tokenizer.save_pretrained('${outputPath}')`,
          `print('GPTQ ${bits}-bit quantization complete')`,
          `"`,
        ].join('\n');
      },
    },
    exl2: {
      name: 'EXL2 (ExLlamaV2)',
      description: 'Variable bits-per-weight — best quality/size ratio, ExLlama inference',
      node: 'px-epyc',
      vmid: 176,
      quants: ['2.0bpw', '2.5bpw', '3.0bpw', '3.5bpw', '4.0bpw', '4.5bpw', '5.0bpw', '5.5bpw', '6.0bpw', '6.5bpw', '8.0bpw'],
      buildCommand(modelPath, outputPath, quantType) {
        const bpw = parseFloat(quantType) || 4.0;
        return [
          `/opt/conda/envs/vllm/bin/python -m exllamav2.convert \\`,
          `  -i "${modelPath}" \\`,
          `  -o "${outputPath}" \\`,
          `  -b ${bpw} \\`,
          `  -cf "${outputPath}"`,
        ].join('\n');
      },
    },
    exl3: {
      name: 'EXL3 (ExLlamaV3)',
      description: 'Next-gen variable BPW — improved quality, faster quantization',
      node: 'px-epyc',
      vmid: 176,
      quants: ['2.0bpw', '2.5bpw', '3.0bpw', '3.5bpw', '4.0bpw', '4.5bpw', '5.0bpw', '5.5bpw', '6.0bpw', '6.5bpw', '8.0bpw'],
      buildCommand(modelPath, outputPath, quantType) {
        const bpw = parseFloat(quantType) || 4.0;
        return [
          `/opt/conda/envs/vllm/bin/python -m exllamav3.convert \\`,
          `  -i "${modelPath}" \\`,
          `  -o "${outputPath}" \\`,
          `  -b ${bpw} \\`,
          `  -cf "${outputPath}"`,
        ].join('\n');
      },
    },
  };
