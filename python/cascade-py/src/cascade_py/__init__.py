"""cascade-py: the Cascade agent server for Python agents (CrewAI, LangGraph, Agno, AutoGen).

Serves the MIP-003 endpoints plus the Cascade extensions, byte-compatible with ``@cascade/agent``.
"""

from .address import enterprise_address, payment_key_hash
from .cose import sign_cose1, verify_cose1
from .hashing import input_hash, jcs, jcs_sha256_hex, mip004_output_hash, pip_masumi_output_hash, result_hash
from .input_schema import input_schema_hash, validate_input_data
from .payment import SettleResponse, StaticRequirements, VerifyResult, default_rail_requirement, decode_header, encode_header
from .server import CascadeAgent, Capabilities, HandlerResult, JobContext, Pricing, cascade_agent
from .signer import AgentSigner, LocalKeySigner
from .start_job import MasumiPaymentServiceBackend, StartJobTerms
from .store import InMemoryJobStore, JobStore

__all__ = [
    "AgentSigner",
    "Capabilities",
    "CascadeAgent",
    "HandlerResult",
    "InMemoryJobStore",
    "JobContext",
    "JobStore",
    "LocalKeySigner",
    "MasumiPaymentServiceBackend",
    "Pricing",
    "SettleResponse",
    "StartJobTerms",
    "StaticRequirements",
    "VerifyResult",
    "cascade_agent",
    "decode_header",
    "default_rail_requirement",
    "encode_header",
    "enterprise_address",
    "input_hash",
    "input_schema_hash",
    "jcs",
    "jcs_sha256_hex",
    "mip004_output_hash",
    "payment_key_hash",
    "pip_masumi_output_hash",
    "result_hash",
    "sign_cose1",
    "validate_input_data",
    "verify_cose1",
]
