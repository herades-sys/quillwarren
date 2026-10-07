"""
Fine-tune Qwen3 on the Delve training data with Unsloth (LoRA on a 4-bit base: QLoRA).

Written for you and NOT run by the generator: installing Python packages and
downloading the base model are your steps (see README.md, "Your steps").

    python train_unsloth.py --dry-run                 # render + count tokens only, no GPU training
    python train_unsloth.py --model unsloth/Qwen3-4B  # train (defaults fit an 8 GB card, see README)
    python train_unsloth.py --export-gguf q4_k_m --adapter delve-qwen3-lora   # afterwards: GGUF for Ollama

Everything that matters for memory and quality is a flag; the defaults are
the plan for the RTX 5060 (8 GB): Qwen3-4B, 4-bit, LoRA rank 16, sequences up
to 8192 tokens, batch 1 with 16 accumulation steps, one epoch.
"""

import argparse
import json
import os
import re
import statistics
import sys
import time

p = argparse.ArgumentParser(description="Fine-tune Qwen3 on the Delve data (Unsloth).")
p.add_argument("--model", default="unsloth/Qwen3-4B",
               help="base model: unsloth/Qwen3-4B (fits 8 GB), unsloth/Qwen3-8B (rent a 24 GB GPU), "
                    "or a local folder. The bench baseline was qwen3:8b; train the size you will run.")
p.add_argument("--data", default=".", help="folder with train.jsonl and valid.jsonl")
p.add_argument("--out", default="delve-qwen3-lora", help="where the LoRA adapter goes")
p.add_argument("--max-seq-len", type=int, default=8192,
               help="longest example kept, in real tokens (longer ones are dropped and counted). "
                    "8192 keeps nearly all; on an 8 GB card this is the setting most likely to run out of memory.")
p.add_argument("--max-examples", type=int, default=0, help="use only the first N training examples (0: all). Try 1500 first.")
p.add_argument("--epochs", type=float, default=1.0, help="1 is usually enough for this much templated data; 2 risks parroting the templates")
p.add_argument("--lr", type=float, default=1e-4, help="LoRA learning rate (2e-4 learns faster, 5e-5 is gentler)")
p.add_argument("--rank", type=int, default=16, help="LoRA rank: 16 is plenty for one tool set; 32 for more capacity")
p.add_argument("--batch", type=int, default=1, help="sequences per step on the GPU (keep 1 with 7-9k-token examples on 8 GB)")
p.add_argument("--grad-accum", type=int, default=16, help="steps accumulated per update: effective batch = batch x grad-accum")
p.add_argument("--load-in-4bit", action=argparse.BooleanOptionalAction, default=True, help="QLoRA (default) or 16-bit LoRA with --no-load-in-4bit (needs much more memory)")
p.add_argument("--eval-steps", type=int, default=0, help="evaluate on valid.jsonl every N steps (0: only at the end; evaluation costs time and memory)")
p.add_argument("--seed", type=int, default=3407)
p.add_argument("--dry-run", action="store_true", help="load the tokenizer, render and count tokens, write rendered_example.txt; no training")
p.add_argument("--export-gguf", metavar="QUANT", default=None,
               help="instead of training: merge --adapter into the base model and write a GGUF (q4_k_m, q5_k_m, q8_0, f16). "
                    "Unsloth fetches and builds llama.cpp for this (a download, your step).")
p.add_argument("--adapter", default=None, help="with --export-gguf: the trained adapter folder (default: --out)")
args = p.parse_args()

# Unsloth must be imported before transformers / trl / peft, so it can patch them.
from unsloth import FastLanguageModel, is_bfloat16_supported  # noqa: E402
from unsloth.chat_templates import train_on_responses_only  # noqa: E402

# ---------------------------------------------------------------- export only
if args.export_gguf:
    adapter = args.adapter or args.out
    model, tokenizer = FastLanguageModel.from_pretrained(model_name=adapter, max_seq_length=args.max_seq_len, load_in_4bit=args.load_in_4bit)
    target = f"{adapter}-gguf"
    # writes target/*.gguf; llama.cpp does the conversion and quantisation
    model.save_pretrained_gguf(target, tokenizer, quantization_method=args.export_gguf)
    print(f"GGUF written to {target}/. Next: README.md, 'Into Ollama'.")
    sys.exit(0)

# ---------------------------------------------------------------- the data
EMPTY_THINK = "<think>\n\n</think>\n\n"


def load_jsonl(path):
    # Plain json, not datasets.load_dataset("json"): pyarrow would merge the 17 tool
    # schemas (and every call's arguments) into one struct per column and fill the
    # gaps with nulls, which then show up in the rendered prompt.
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def load_model():
    return FastLanguageModel.from_pretrained(
        model_name=args.model,
        max_seq_length=args.max_seq_len,
        load_in_4bit=args.load_in_4bit,
        dtype=None,  # bf16 on the RTX 5060 (Blackwell), picked automatically
    )


if args.dry_run:
    from transformers import AutoTokenizer
    tokenizer = AutoTokenizer.from_pretrained(args.model)
    model = None
else:
    model, tokenizer = load_model()

# Hybrid Qwen3 models (Qwen3-4B, Qwen3-8B) have a chat template with an
# enable_thinking switch. With thinking off, Ollama starts every assistant reply
# with an empty think block, so every assistant turn is trained after one (the
# Hugging Face template only puts it on the last turn). Non-thinking models
# (Qwen3-4B-Instruct-2507) never see think tags: nothing is added for them.
HYBRID = "enable_thinking" in (tokenizer.chat_template or "")


def render(example):
    text = tokenizer.apply_chat_template(example["messages"], tools=example["tools"], tokenize=False, add_generation_prompt=False)
    if HYBRID:
        text = re.sub(r"<\|im_start\|>assistant\n(?!<think>)", "<|im_start|>assistant\n" + EMPTY_THINK, text)
    return text


def prepare(rows, name):
    texts, lengths, dropped = [], [], 0
    for row in rows:
        t = render(row)
        n = len(tokenizer(t, add_special_tokens=False)["input_ids"])
        if n > args.max_seq_len:
            dropped += 1
            continue
        texts.append(t)
        lengths.append(n)
    if lengths:
        q = statistics.quantiles(lengths, n=20)
        print(f"{name}: {len(texts)} kept, {dropped} longer than {args.max_seq_len} tokens dropped; "
              f"tokens min {min(lengths)}, median {int(statistics.median(lengths))}, p95 {int(q[18])}, max {max(lengths)}; "
              f"{sum(lengths) / 1e6:.1f} M tokens")
    return texts


train_rows = load_jsonl(os.path.join(args.data, "train.jsonl"))
if args.max_examples:
    train_rows = train_rows[: args.max_examples]
valid_rows = load_jsonl(os.path.join(args.data, "valid.jsonl"))
train_texts = prepare(train_rows, "train")
valid_texts = prepare(valid_rows, "valid")

if args.dry_run:
    with open("rendered_example.txt", "w", encoding="utf-8") as f:
        f.write(train_texts[0])
    print(f"Wrote rendered_example.txt (the first training example as the model will see it). Hybrid thinking template: {HYBRID}.")
    sys.exit(0)

from datasets import Dataset  # noqa: E402
from trl import SFTConfig, SFTTrainer  # noqa: E402

train_ds = Dataset.from_dict({"text": train_texts})
valid_ds = Dataset.from_dict({"text": valid_texts})

# ---------------------------------------------------------------- LoRA
model = FastLanguageModel.get_peft_model(
    model,
    r=args.rank,
    lora_alpha=args.rank,  # alpha = rank: a scale of 1, a safe default
    lora_dropout=0,  # Unsloth's fast path; the data is large enough not to need dropout
    target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
    bias="none",
    use_gradient_checkpointing="unsloth",  # offloads activations: what makes 8k-token sequences fit in 8 GB at all
    random_state=args.seed,
)

steps_per_epoch = max(1, len(train_texts) // (args.batch * args.grad_accum))
trainer = SFTTrainer(
    model=model,
    tokenizer=tokenizer,  # newer TRL versions call this processing_class
    train_dataset=train_ds,
    eval_dataset=valid_ds,
    args=SFTConfig(
        dataset_text_field="text",
        packing=False,  # one conversation per sequence: they are long already
        per_device_train_batch_size=args.batch,
        per_device_eval_batch_size=1,
        gradient_accumulation_steps=args.grad_accum,
        num_train_epochs=args.epochs,
        learning_rate=args.lr,
        lr_scheduler_type="cosine",
        warmup_steps=max(5, steps_per_epoch // 30),
        weight_decay=0.01,
        optim="adamw_8bit",
        fp16=not is_bfloat16_supported(),
        bf16=is_bfloat16_supported(),
        logging_steps=5,
        eval_strategy="steps" if args.eval_steps else "no",
        eval_steps=args.eval_steps or None,
        save_strategy="steps",
        save_steps=max(50, steps_per_epoch // 4),
        save_total_limit=3,
        output_dir=args.out + "-checkpoints",
        dataloader_num_workers=0,  # Windows: no worker processes
        seed=args.seed,
        report_to="none",
    ),
)

# Learn only the assistant turns (tool calls and answers). The system prompt, the
# tool definitions, the user messages with their context block and the tool results
# are context: masked out of the loss.
trainer = train_on_responses_only(trainer, instruction_part="<|im_start|>user\n", response_part="<|im_start|>assistant\n")

print(f"{len(train_texts)} examples, {steps_per_epoch} optimizer steps per epoch (batch {args.batch} x {args.grad_accum}).")
print("The first steps print their time; multiply by the steps to see how long the run takes.")
start = time.time()
stats = trainer.train()
print(f"Trained in {(time.time() - start) / 3600:.1f} h; final train loss {stats.training_loss:.4f}")
if valid_texts:
    print("valid:", trainer.evaluate())

model.save_pretrained(args.out)
tokenizer.save_pretrained(args.out)
print(f"LoRA adapter saved to {args.out}/. Next: python train_unsloth.py --export-gguf q4_k_m --adapter {args.out}")
