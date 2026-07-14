#!/usr/bin/env python3
"""
OpenClaw Auto-FineTune Pipeline
Collects training data from learning_log.jsonl,
runs QLoRA fine-tuning, exports to Ollama as clawai-finetuned.
"""

import os
import json
import subprocess
import shutil
from pathlib import Path
from datetime import datetime

# PYTHON = auto-detected
OPENCLAW_DIR = Path(os.environ.get('USERPROFILE', '')) / '.openclaw'
TRAINING_DATA_DIR = OPENCLAW_DIR / "learning_data"
STATE_FILE = OPENCLAW_DIR / "auto-finetune-state.json"
OLLAMA_MODELS_DIR = Path(os.environ.get("OLLAMA_MODELS", os.path.join(os.environ.get("OLLAMA_MODELS_PARENT", os.environ.get("USERPROFILE", ".")), "Ollama", "Models")))
CHECKPOINT_DIR = OPENCLAW_DIR / "fine-tune-checkpoint"
SCRIPT_DIR = Path(__file__).parent

# Thresholds
MIN_CONVERSATIONS = 50
MAX_CONVERSATIONS = 500
FINE_TUNE_EPOCHS = 3
FINE_TUNE_BATCH_SIZE = 4
FINE_TUNE_LR = 1e-4
QUALITY_THRESHOLD = 80


def load_state():
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    return {"last_finetune": None, "conversation_count": 0, "trained_until": None}


def save_state(state):
    STATE_FILE.write_text(json.dumps(state, indent=2, ensure_ascii=False, default=str))


def collect_training_data():
    """Collect Q&A pairs from learning_log.jsonl."""
    log_file = TRAINING_DATA_DIR / "learning_log.jsonl"
    if not log_file.exists():
        print(f"No training data found at {log_file}")
        return []

    conversations = []
    with open(log_file, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
                question = entry.get("question", "").strip()
                student_answer = entry.get("studentAnswer", "").strip()
                if question and student_answer and len(question) > 5 and len(student_answer) > 10:
                    conversations.append({
                        "instruction": question,
                        "output": student_answer,
                        "timestamp": entry.get("timestamp", ""),
                    })
            except json.JSONDecodeError:
                continue

    return conversations[:MAX_CONVERSATIONS]


def prepare_dataset(conversations):
    """Prepare dataset in Alpaca format."""
    dataset_dir = CHECKPOINT_DIR / "dataset"
    dataset_dir.mkdir(parents=True, exist_ok=True)

    alpaca_data = []
    for conv in conversations:
        alpaca_data.append({
            "instruction": conv["instruction"],
            "input": "",
            "output": conv["output"],
        })

    dataset_file = dataset_dir / "train.jsonl"
    with open(dataset_file, "w", encoding="utf-8") as f:
        for item in alpaca_data:
            f.write(json.dumps(item, ensure_ascii=False) + "\n")

    stats = {
        "total_conversations": len(alpaca_data),
        "dataset_file": str(dataset_file),
        "created_at": datetime.now().isoformat(),
    }
    with open(dataset_dir / "stats.json", "w", encoding="utf-8") as f:
        json.dump(stats, f, indent=2, ensure_ascii=False)

    return dataset_file


def run_finetune(dataset_file):
    """Run QLoRA fine-tuning on gemma-2-2b-it."""
    dataset_lines = sum(1 for _ in open(dataset_file, encoding="utf-8"))
    print(f"Starting QLoRA fine-tuning on {dataset_lines} conversations...")

    train_script = f'''
import json
import torch
from datasets import load_dataset
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    TrainingArguments,
    Trainer,
    DataCollatorForSeq2Seq,
    BitsAndBytesConfig,
)
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training

MODEL_ID = "google/gemma-2-2b-it"
OUTPUT_DIR = "{CHECKPOINT_DIR / "ft_output"}"
DATASET_FILE = "{dataset_file}"
NUM_EPOCHS = {FINE_TUNE_EPOCHS}
BATCH_SIZE = {FINE_TUNE_BATCH_SIZE}
LEARNING_RATE = {FINE_TUNE_LR}
LORA_R = 16
LORA_ALPHA = 32

# Load model with 4-bit quantization
bnb_config = BitsAndBytesConfig(
    load_in_4bit=True,
    bnb_4bit_quant_type="nf4",
    bnb_4bit_compute_dtype=torch.float16,
    bnb_4bit_use_double_quant=True,
)

model = AutoModelForCausalLM.from_pretrained(
    MODEL_ID,
    quantization_config=bnb_config,
    torch_dtype=torch.float16,
    device_map="auto",
    trust_remote_code=True,
)
model = prepare_model_for_kbit_training(model)

# Configure LoRA
lora_config = LoraConfig(
    r=LORA_R,
    lora_alpha=LORA_ALPHA,
    target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
    lora_dropout=0.05,
    bias="none",
    task_type="CAUSAL_LM",
)
model = get_peft_model(model, lora_config)
model.print_trainable_parameters()

# Load tokenizer
tokenizer = AutoTokenizer.from_pretrained(MODEL_ID, trust_remote_code=True)
tokenizer.pad_token = tokenizer.eos_token
tokenizer.padding_side = "right"

# Load dataset
def tokenize_fn(example):
    prompt = f"### Instruction:\\n{{example['instruction']}}\\n\\n### Output:\\n{{example['output']}}"
    tokens = tokenizer(prompt, truncation=True, max_length=512)
    tokens["labels"] = tokens["input_ids"].copy()
    return tokens

dataset = load_dataset("json", data_files=str(DATASET_FILE))
dataset = dataset.map(tokenize_fn, batched=True, remove_columns=["instruction", "input", "output"])
train_dataset = dataset["train"].shuffle(seed=42)

# Train
training_args = TrainingArguments(
    output_dir=OUTPUT_DIR,
    num_train_epochs=NUM_EPOCHS,
    per_device_train_batch_size=BATCH_SIZE,
    gradient_accumulation_steps=2,
    learning_rate=LEARNING_RATE,
    fp16=True,
    logging_steps=10,
    save_strategy="epoch",
    evaluation_strategy="epoch",
    optim="paged_adamw_8bit",
)

trainer = Trainer(
    model=model,
    args=training_args,
    train_dataset=train_dataset,
    data_collator=DataCollatorForSeq2Seq(tokenizer=tokenizer, padding=True),
)

print("Starting training...")
trainer.train()
trainer.save_model(OUTPUT_DIR)
print(f"Training complete. Model saved to {OUTPUT_DIR}")
'''

    script_file = CHECKPOINT_DIR / "train.py"
    script_file.write_text(train_script, encoding="utf-8")

    result = subprocess.run(
        [PYTHON, str(script_file)],
        capture_output=True,
        text=True,
        timeout=7200,
    )

    if result.returncode != 0:
        print(f"Training failed:\n{result.stderr[-2000:]}")
        return False

    return True


def export_model():
    """Export fine-tuned LoRA adapter to Ollama format."""
    ft_output = CHECKPOINT_DIR / "ft_output"
    adapter_path = ft_output / "adapter_model.safetensors"

    if not adapter_path.exists():
        print("No fine-tuned adapter found.")
        return False

    # Create Ollama Modelfile
    modelfile = f"""FROM gemma2:2b

PARAMETER num_ctx 4096
PARAMETER temperature 0.7

TEMPLATE \"\"\"{{{{ if .System }}}}<start_of_turn>system\\n{{{{ .System }}}}<end_of_turn>
{{{{ end }}}}{{{{ if .Prompt }}}}<start_of_turn>user\\n{{{{ .Prompt }}}}<end_of_turn>
{{{{ end }}}}{{{{ .Response }}}}>\"\"\"

ADAPTER {adapter_path}
"""
    modelfile_path = CHECKPOINT_DIR / "Modelfile"
    modelfile_path.write_text(modelfile, encoding="utf-8")

    ollama_bin = (shutil.which("ollama") or r"C:\\Program Files\\Ollama\\ollama.exe")
    result = subprocess.run(
        [ollama_bin, "create", "clawai-finetuned", "-f", str(modelfile_path)],
        capture_output=True,
        text=True,
        timeout=600,
    )

    if result.returncode != 0:
        print(f"Ollama export failed:\n{result.stderr}")
        return False

    print("Model exported as 'clawai-finetuned' in Ollama!")
    return True


def main():
    print("=" * 60)
    print("OpenClaw Auto-FineTune Pipeline")
    print("=" * 60)

    state = load_state()
    print(f"\nState: last_finetune={state.get('last_finetune')}, "
          f"conversations={state.get('conversation_count', 0)}")

    print("\nCollecting training data from learning_log.jsonl...")
    conversations = collect_training_data()
    print(f"Collected {len(conversations)} conversation pairs")

    if len(conversations) < MIN_CONVERSATIONS:
        print(f"Not enough data. Need {MIN_CONVERSATIONS}, have {len(conversations)}.")
        return

    print("\nPreparing dataset...")
    dataset_file = prepare_dataset(conversations)
    print(f"Dataset: {dataset_file}")

    print("\nStarting QLoRA fine-tuning (this may take a while)...")
    if run_finetune(dataset_file):
        print("\nFine-tuning completed!")
        print("\nExporting to Ollama...")
        if export_model():
            state["last_finetune"] = datetime.now().isoformat()
            state["conversation_count"] = len(conversations)
            state["trained_until"] = datetime.now().isoformat()
            save_state(state)
            print("\nDone! New model: clawai-finetuned")
            print("To use it, set studentModel to 'ollama/clawai-finetuned' in model settings")
        else:
            print("Export failed.")
    else:
        print("Training failed.")


if __name__ == "__main__":
    main()
