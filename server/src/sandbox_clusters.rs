//! Durable presentation metadata for sandbox batches created by the console.
//!
//! The manager owns sandbox lifecycle state. This registry only remembers the
//! exact IDs returned by a cluster-mode create request so every browser
//! origin can render the same batch as a cluster.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use http::{Method, Request, Response, StatusCode};
use http_body_util::BodyExt as _;
use hyper::body::Incoming;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::RwLock;

use crate::response::{self, BoxBody};

const MAX_REGISTRY_REQUEST_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxClusterRecord {
    pub id: String,
    pub member_ids: Vec<String>,
    pub workspace_root: String,
    pub created_at: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct SandboxClusterRegistry {
    clusters: Vec<SandboxClusterRecord>,
}

#[derive(Debug, Deserialize)]
struct SandboxClusterRemoval {
    id: String,
}

#[derive(Debug)]
pub struct SandboxClusterStore {
    path: PathBuf,
    clusters: RwLock<Vec<SandboxClusterRecord>>,
}

impl SandboxClusterStore {
    #[must_use]
    pub fn load(path: PathBuf) -> Self {
        let clusters = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<SandboxClusterRegistry>(&bytes).ok())
            .map_or_else(Vec::new, |registry| {
                registry.clusters.into_iter().filter(valid_record).collect()
            });
        Self {
            path,
            clusters: RwLock::new(clusters),
        }
    }

    async fn list(&self) -> Vec<SandboxClusterRecord> {
        self.clusters.read().await.clone()
    }

    async fn register(&self, cluster: SandboxClusterRecord) -> std::io::Result<()> {
        let member_ids = cluster
            .member_ids
            .iter()
            .collect::<std::collections::HashSet<_>>();
        let mut clusters = self.clusters.write().await;
        clusters.retain(|candidate| {
            candidate.id != cluster.id
                && !candidate
                    .member_ids
                    .iter()
                    .any(|member_id| member_ids.contains(member_id))
        });
        clusters.push(cluster);
        persist(&self.path, &clusters).await
    }

    async fn remove(&self, id: &str) -> std::io::Result<bool> {
        let mut clusters = self.clusters.write().await;
        let previous_len = clusters.len();
        clusters.retain(|cluster| cluster.id != id);
        if clusters.len() == previous_len {
            return Ok(false);
        }
        persist(&self.path, &clusters).await?;
        Ok(true)
    }
}

pub async fn handle(store: &Arc<SandboxClusterStore>, req: Request<Incoming>) -> Response<BoxBody> {
    match *req.method() {
        Method::GET => response::no_store(response::json_value(
            StatusCode::OK,
            &json!({ "clusters": store.list().await }),
        )),
        Method::POST => register(store, req).await,
        Method::DELETE => remove(store, req).await,
        _ => response::text(StatusCode::METHOD_NOT_ALLOWED, "use GET, POST, or DELETE"),
    }
}

async fn register(store: &SandboxClusterStore, req: Request<Incoming>) -> Response<BoxBody> {
    let body = http_body_util::Limited::new(req.into_body(), MAX_REGISTRY_REQUEST_BYTES);
    let bytes = match body.collect().await {
        Ok(collected) => collected.to_bytes(),
        Err(_) => {
            return response::text(
                StatusCode::BAD_REQUEST,
                "cluster request exceeded the size limit",
            )
        }
    };
    let cluster = match serde_json::from_slice::<SandboxClusterRecord>(&bytes) {
        Ok(cluster) if valid_record(&cluster) => cluster,
        Ok(_) => {
            return response::text(
                StatusCode::BAD_REQUEST,
                "cluster requires an id, createdAt, and at least one unique memberId",
            )
        }
        Err(error) => {
            return response::text(
                StatusCode::BAD_REQUEST,
                &format!("cluster request is not valid json: {error}"),
            )
        }
    };
    if let Err(error) = store.register(cluster.clone()).await {
        return response::text(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("could not persist sandbox cluster: {error}"),
        );
    }
    response::no_store(response::json_value(StatusCode::OK, &json!(cluster)))
}

async fn remove(store: &SandboxClusterStore, req: Request<Incoming>) -> Response<BoxBody> {
    let body = http_body_util::Limited::new(req.into_body(), MAX_REGISTRY_REQUEST_BYTES);
    let bytes = match body.collect().await {
        Ok(collected) => collected.to_bytes(),
        Err(_) => {
            return response::text(
                StatusCode::BAD_REQUEST,
                "cluster request exceeded the size limit",
            )
        }
    };
    let removal = match serde_json::from_slice::<SandboxClusterRemoval>(&bytes) {
        Ok(removal) if !removal.id.trim().is_empty() => removal,
        Ok(_) => return response::text(StatusCode::BAD_REQUEST, "cluster id is required"),
        Err(error) => {
            return response::text(
                StatusCode::BAD_REQUEST,
                &format!("cluster request is not valid json: {error}"),
            )
        }
    };
    let removed = match store.remove(&removal.id).await {
        Ok(removed) => removed,
        Err(error) => {
            return response::text(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("could not persist sandbox clusters: {error}"),
            )
        }
    };
    response::no_store(response::json_value(
        StatusCode::OK,
        &json!({ "id": removal.id, "removed": removed }),
    ))
}

fn valid_record(cluster: &SandboxClusterRecord) -> bool {
    if cluster.id.trim().is_empty()
        || cluster.created_at.trim().is_empty()
        || cluster.member_ids.is_empty()
        || cluster.member_ids.iter().any(|id| id.trim().is_empty())
    {
        return false;
    }
    let unique = cluster
        .member_ids
        .iter()
        .collect::<std::collections::HashSet<_>>();
    unique.len() == cluster.member_ids.len()
}

async fn persist(path: &Path, clusters: &[SandboxClusterRecord]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let temporary = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(&SandboxClusterRegistry {
        clusters: clusters.to_vec(),
    })
    .map_err(std::io::Error::other)?;
    tokio::fs::write(&temporary, bytes).await?;
    tokio::fs::rename(temporary, path).await
}

#[cfg(test)]
mod tests {
    use super::{valid_record, SandboxClusterRecord};

    fn record(member_ids: &[&str]) -> SandboxClusterRecord {
        SandboxClusterRecord {
            id: "cluster-a".to_owned(),
            member_ids: member_ids.iter().map(ToString::to_string).collect(),
            workspace_root: "/work".to_owned(),
            created_at: "2026-07-18T00:00:00Z".to_owned(),
        }
    }

    #[test]
    fn validation_requires_at_least_one_distinct_member() {
        assert!(valid_record(&record(&["one", "two"])));
        assert!(valid_record(&record(&["one"])));
        assert!(!valid_record(&record(&[])));
        assert!(!valid_record(&record(&["one", "one"])));
    }
}
