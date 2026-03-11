"""
PGMN Ad Launcher — FastAPI Backend
Simple API for launching, monitoring, and optimizing Meta ad campaigns.
"""

import os
import sys

# Add backend dir to path so imports work from any cwd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import Optional
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '.env'))

import meta_api
import optimizer

app = FastAPI(title="PGMN Ad Launcher", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─── Request Models ───

class LaunchRequest(BaseModel):
    content_url: str
    budget_php: float
    duration_days: int
    page_id: str
    post_id: Optional[str] = None
    campaign_name: Optional[str] = None
    platform: str = "both"  # both, facebook_only, instagram_only
    ab_test: bool = False


class StatusUpdate(BaseModel):
    campaign_id: str
    action: str  # pause, activate, archive


class BudgetUpdate(BaseModel):
    adset_id: str
    new_budget_php: float


# ─── Endpoints ───

@app.get("/")
def root():
    return {"status": "PGMN Ad Launcher is running", "version": "1.0.0"}


@app.get("/api/campaigns")
def list_campaigns():
    """Get all campaigns (recent)."""
    try:
        return meta_api.get_campaigns(limit=30)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/campaigns/active")
def list_active_campaigns():
    """Get only active campaigns."""
    try:
        return meta_api.get_active_campaigns()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/campaigns/{campaign_id}/insights")
def campaign_insights(campaign_id: str):
    """Get detailed insights for a specific campaign."""
    try:
        insights = meta_api.get_campaign_insights(campaign_id, date_preset='lifetime')
        if insights.get('data'):
            return meta_api.calculate_metrics(insights['data'][0])
        return {"message": "No data available yet"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/launch")
def launch_campaign(req: LaunchRequest):
    """
    Launch a new campaign. This is the main endpoint.
    Provide a content URL, budget, and duration — everything else is automated.
    """
    try:
        result = meta_api.launch_burst_campaign(
            content_url=req.content_url,
            budget_php=req.budget_php,
            duration_days=req.duration_days,
            page_id=req.page_id,
            post_id=req.post_id,
            campaign_name=req.campaign_name,
            platform=req.platform,
            ab_test=req.ab_test,
        )
        return {"status": "created", "data": result}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/campaigns/status")
def update_status(req: StatusUpdate):
    """Pause, activate, or archive a campaign."""
    try:
        if req.action == 'pause':
            return meta_api.pause_campaign(req.campaign_id)
        elif req.action == 'activate':
            return meta_api.activate_campaign(req.campaign_id)
        elif req.action == 'archive':
            return meta_api.archive_campaign(req.campaign_id)
        else:
            raise HTTPException(status_code=400, detail=f"Unknown action: {req.action}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/campaigns/budget")
def update_budget(req: BudgetUpdate):
    """Update an ad set's budget."""
    try:
        return meta_api.update_adset_budget(req.adset_id, req.new_budget_php)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/stats")
def quick_stats():
    """Quick performance summary of last 7 days (no AI)."""
    try:
        return optimizer.get_quick_stats()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/optimize")
def run_optimization(dry_run: bool = True):
    """
    Run Claude AI analysis on active campaigns.
    dry_run=True (default): Only returns recommendations.
    dry_run=False: Also executes KILL recommendations automatically.
    """
    try:
        return optimizer.auto_optimize(dry_run=dry_run)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/performance")
def performance_report(days: int = 7):
    """Get campaign performance summary for the last N days."""
    try:
        return meta_api.get_campaign_performance_summary(days=days)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# Serve frontend
frontend_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'frontend')

@app.get("/app")
def serve_frontend():
    return FileResponse(os.path.join(frontend_dir, 'index.html'))
