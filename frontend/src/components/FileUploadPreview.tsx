import React from 'react';
import './FileUploadPreview.css';

interface FileUploadPreviewProps {
  file: File;
  onRemove: () => void;
  isUploading: boolean;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const FileUploadPreview: React.FC<FileUploadPreviewProps> = ({ file, onRemove, isUploading }) => {
  return (
    <div className="file-upload-preview">
      <div className="file-preview-info">
        <span className="file-preview-name">{file.name}</span>
        <span className="file-preview-size">{formatFileSize(file.size)}</span>
      </div>
      {isUploading ? (
        <span className="file-preview-uploading">Uploading...</span>
      ) : (
        <button className="file-preview-remove" onClick={onRemove} title="Remove file">
          &times;
        </button>
      )}
    </div>
  );
};

export default FileUploadPreview;
