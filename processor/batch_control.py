"""Durable batch results and explicit user decisions after individual failures."""
from __future__ import annotations

import json
import os
from pathlib import Path
import time
from uuid import uuid4

from .progress import callback_configured, latest_control


class BatchStopped(RuntimeError):
    def __init__(self, reason: str, status: str = "error"):
        super().__init__(reason)
        self.status = status


class BatchControl:
    def __init__(self, request_id, folder_id, output, total, emitter):
        self.request_id, self.folder_id = request_id, folder_id
        self.output, self.total, self.emitter = Path(output), total, emitter
        self.cuts, self.errors, self.pending_cuts = [], [], []
        self.consecutive_failures = 0
        self.stop_reason = None

    @property
    def percent(self):
        # Only complete Drive uploads earn batch progress.
        return 10.0 + 85.0 * len(self.cuts) / self.total

    def result(self):
        result = {
            "requestId": self.request_id, "folderId": self.folder_id,
            "driveFolderUrl": f"https://drive.google.com/drive/folders/{self.folder_id}",
            "cuts": list(self.cuts), "errors": list(self.errors),
            "requestedCount": self.total, "completedCount": len(self.cuts),
            "failedCount": len(self.errors), "consecutiveFailures": self.consecutive_failures,
            "pendingCuts": list(self.pending_cuts),
        }
        if self.stop_reason:
            result["stoppedReason"] = self.stop_reason
        return result

    def persist(self):
        path = self.output / "render-batch-result.json"
        temporary = path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(self.result(), ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(path)

    @staticmethod
    def action(response, decision_id=None):
        control = response.get("control") if isinstance(response, dict) else None
        if not isinstance(control, dict):
            return "wait"
        if decision_id is not None and control.get("decisionId") != decision_id:
            return "wait"
        return control.get("action", "wait")

    def check_stop(self, response=None):
        control = response.get("control", {}) if isinstance(response, dict) else {}
        direct_stop = isinstance(control, dict) and control.get("action") == "stop" and control.get("decisionId") is None
        if direct_stop or latest_control().get("action") == "stop":
            raise BatchStopped("Processamento interrompido pelo usuário; os cortes já salvos foram preservados.", "cancelled")

    def emit(self, stage, _overall=None, detail="", *, observe_stop=True, **kwargs):
        response = self.emitter(stage, self.percent, detail, total_cuts=self.total,
                                completed_count=len(self.cuts), failed_count=len(self.errors),
                                consecutive_failures=self.consecutive_failures,
                                result=self.result(), **{k: v for k, v in kwargs.items() if k != "total_cuts"})
        if observe_stop:
            self.check_stop(response)
        return response

    def succeeded(self, cut):
        self.pending_cuts[:] = [row for row in self.pending_cuts if row["index"] != cut["index"]]
        self.cuts.append(cut)
        self.consecutive_failures = 0
        self.persist()
        self.emit("cortes", detail=f"Corte {cut['index']}/{self.total} salvo integralmente no Google Drive",
                  cut=cut["index"], ready_cut=cut)

    def pending(self, cut):
        self.pending_cuts[:] = [row for row in self.pending_cuts if row["index"] != cut["index"]]
        self.pending_cuts.append(cut)
        self.persist()

    def failed_cut(self, corte, index, exc, *, uploaded_files=None):
        error = {"index": index, "titulo": corte["titulo"], "error": str(exc)}
        if uploaded_files:
            error["uploadedFiles"] = dict(uploaded_files)
        self.errors.append(error)
        self.consecutive_failures += 1
        self.persist()
        if self.consecutive_failures >= 3:
            # Persist the third error even when the terminal callback is unavailable.
            raise BatchStopped("Processamento interrompido após 3 falhas consecutivas. "
                               f"Último erro no corte {index}: {exc}")

        decision_id = str(uuid4())
        detail = f"Corte {index}/{self.total} falhou: {exc}. Escolha parar ou continuar."
        fields = dict(status="paused", cut=index, cut_error=error, decision_id=decision_id,
                      completed_count=len(self.cuts), failed_count=len(self.errors),
                      consecutive_failures=self.consecutive_failures, total_cuts=self.total,
                      result=self.result(), error=str(exc))
        # Offline/unit-test runs still enforce the three-failure circuit breaker.
        if not callback_configured():
            self.emitter("aguardando_decisao", self.percent, detail, **fields)
            return

        timeout = max(3.0, float(os.getenv("OS4_DECISION_TIMEOUT_SECONDS", "1800")))
        deadline = time.monotonic() + timeout
        unreachable = 0
        while True:
            response = self.emitter("aguardando_decisao", self.percent, detail, **fields)
            action = self.action(response, decision_id)
            if action == "wait":
                action = self.action({"control": latest_control()}, decision_id)
            if action == "stop":
                raise BatchStopped("Processamento interrompido pelo usuário após uma falha; resultados preservados.", "cancelled")
            if action == "continue":
                # Continuing skips this failed cut; only a saved cut resets the streak.
                self.emit("cortes", detail=f"Continuando após a falha do corte {index}", cut=index)
                return
            unreachable = unreachable + 1 if response is None else 0
            if unreachable >= 3:
                raise BatchStopped("Processamento interrompido: não foi possível consultar a decisão do usuário após a falha.")
            if time.monotonic() >= deadline:
                raise BatchStopped("Processamento interrompido: tempo de espera pela decisão do usuário esgotado.")
            time.sleep(min(3.0, max(0.0, deadline - time.monotonic())))

    def stopped(self, exc):
        self.stop_reason = str(exc)
        self.persist()
        self.emitter("cancelado" if exc.status == "cancelled" else "erro", self.percent,
                     self.stop_reason, status=exc.status, error=self.stop_reason,
                     result=self.result(), total_cuts=self.total,
                     completed_count=len(self.cuts), failed_count=len(self.errors),
                     consecutive_failures=self.consecutive_failures,
                     **({"cut_error": self.errors[-1]} if self.errors else {}))
