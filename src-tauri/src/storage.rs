//! Durable on-disk state: user annotations and a cache of the parsed
//! baseline so cold launches don't re-parse the PDF.

pub(crate) mod error;
pub(crate) mod model;
pub(crate) mod paths;
pub(crate) mod persist;
