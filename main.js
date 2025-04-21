// Load clip details
function loadClipDetails(clipId) {
  apiRequest('GET', `/clips`)
    .then(clips => {
      const clip = clips.find(c => c.id === clipId);
      
      if (!clip) {
        showToast('Clip not found', 'error');
        return;
      }
      
      showClipView(clip);
    })
    .catch(error => {
      console.error('Error loading clip details:', error);
      showToast('Failed to load clip details', 'error');
    });
}

// Show clip view
function showClipView(clip) {
  // Store current clip
  currentClip = clip;
  
  // Hide other views
  $('#welcome-screen').addClass('d-none');
  $('#capture-view').addClass('d-none');
  
  // Show clip view
  $('#clip-view').removeClass('d-none');
  
  // Populate clip info
  $('#clip-view-title').text(clip.title || 'Untitled Clip');
  $('#clip-view-platform').text(clip.platform || 'Unknown');
  $('#clip-view-streamer').text(clip.streamerId || 'Unknown');
  
  // Calculate duration from video if available
  const video = document.createElement('video');
  video.src = clip.file;
  video.onloadedmetadata = function() {
    $('#clip-view-duration').text(formatTime(video.duration));
  };
  
  $('#clip-view-created').text(formatDate(clip.created));
  
  // Set video source
  $('#clip-source').attr('src', clip.file);
  $('#clip-player')[0].load();
  
  // Set clip URL if uploaded
  if (clip.uploadedUrl) {
    $('#clip-url').val(clip.uploadedUrl);
    $('#upload-clip').addClass('d-none');
  } else {
    $('#clip-url').val('Upload clip to generate URL');
    $('#upload-clip').removeClass('d-none');
  }
  
  // Reset upload progress
  $('#upload-progress-container').addClass('d-none');
  $('#upload-progress-bar').css('width', '0%');
  $('#upload-progress-text').text('0%');
  
  // Enable upload button
  $('#upload-clip').prop('disabled', false);
  
  // Hide copy success message
  $('#copy-success').addClass('d-none');
}

// Hide clip view
function hideClipView() {
  $('#clip-view').addClass('d-none');
  $('#welcome-screen').removeClass('d-none');
  
  // Pause video
  $('#clip-player')[0].pause();
}

// Upload clip to pomf.lain.la
function uploadClip() {
  if (!currentClip) {
    showToast('No clip selected', 'error');
    return;
  }
  
  // Disable upload button
  $('#upload-clip').prop('disabled', true);
  
  // Show progress
  $('#upload-progress-container').removeClass('d-none');
  $('#upload-progress-bar').css('width', '0%');
  $('#upload-progress-text').text('0%');
  
  // Upload via socket
  socket.emit('upload_clip', {
    clipId: currentClip.id
  });
  
  socket.once('upload_started', function() {
    showToast('Upload started', 'info');
  });
}

// Delete clip
function deleteClip() {
  if (!currentClip) {
    showToast('No clip selected', 'error');
    $('#delete-confirm-modal').modal('hide');
    return;
  }
  
  apiRequest('DELETE', `/clips/${currentClip.id}`)
    .then(() => {
      $('#delete-confirm-modal').modal('hide');
      showToast('Clip deleted successfully', 'success');
      hideClipView();
      loadClips();
    })
    .catch(error => {
      console.error('Error deleting clip:', error);
      showToast('Failed to delete clip', 'error');
      $('#delete-confirm-modal').modal('hide');
    });
}

// Copy URL to clipboard
function copyToClipboard() {
  const url = $('#clip-url').val();
  
  if (!url || url === 'Upload clip to generate URL') {
    showToast('No URL available', 'error');
    return;
  }
  
  navigator.clipboard.writeText(url)
    .then(() => {
      $('#copy-success').removeClass('d-none');
      
      // Hide success message after 3 seconds
      setTimeout(() => {
        $('#copy-success').addClass('d-none');
      }, 3000);
    })
    .catch(() => {
      showToast('Failed to copy URL', 'error');
    });
}

// Show API key modal
function showApiKeyModal() {
  $('#api-key-error').addClass('d-none');
  $('#api-key-input').val('');
  $('#api-key-modal').modal({
    backdrop: 'static',
    keyboard: false
  });
  $('#api-key-modal').modal('show');
}

/**
 * Utility Functions
 */

// Format time (seconds) to MM:SS
function formatTime(seconds) {
  if (isNaN(seconds)) return '0:00';
  
  seconds = Math.floor(seconds);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

// Format date
function formatDate(dateString) {
  if (!dateString) return 'Unknown';
  
  const date = new Date(dateString);
  
  if (isNaN(date.getTime())) return 'Unknown';
  
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

// Format viewer count (e.g. 1.2K)
function formatViewerCount(count) {
  if (!count) return '0';
  
  if (count >= 1000000) {
    return (count / 1000000).toFixed(1) + 'M';
  } else if (count >= 1000) {
    return (count / 1000).toFixed(1) + 'K';
  }
  
  return count.toString();
}

// Get platform color
function getPlatformColor(platform) {
  switch (platform?.toLowerCase()) {
    case 'kick':
      return 'success';
    case 'youtube':
      return 'danger';
    case 'twitch':
      return 'primary';
    case 'parti':
      return 'warning';
    default:
      return 'secondary';
  }
}

// Get status color
function getStatusColor(status) {
  switch (status) {
    case 'initializing':
      return 'info';
    case 'capturing':
      return 'primary';
    case 'processing':
      return 'success';
    case 'uploading':
      return 'warning';
    case 'error':
      return 'danger';
    default:
      return 'secondary';
  }
}

// Get job type label
function getJobTypeLabel(status) {
  switch (status) {
    case 'initializing':
    case 'capturing':
      return 'Capturing Stream';
    case 'processing':
      return 'Creating Clip';
    case 'uploading':
      return 'Uploading Clip';
    default:
      return 'Job';
  }
}

// Show toast notification
function showToast(message, type = 'info') {
  // Set toast title based on type
  const titleMap = {
    'success': 'Success',
    'error': 'Error',
    'info': 'Information',
    'warning': 'Warning'
  };
  
  $('#toast-title').text(titleMap[type] || 'Notification');
  
  // Set toast body
  $('#toast-message').text(message);
  
  // Set toast class based on type
  $('#toast-notification').removeClass('bg-success bg-danger bg-info bg-warning');
  
  switch (type) {
    case 'success':
      $('#toast-notification').addClass('bg-success text-white');
      break;
    case 'error':
      $('#toast-notification').addClass('bg-danger text-white');
      break;
    case 'warning':
      $('#toast-notification').addClass('bg-warning');
      break;
    case 'info':
      $('#toast-notification').addClass('bg-info text-white');
      break;
  }
  
  // Show toast
  const toastElement = new bootstrap.Toast($('#toast-notification'));
  toastElement.show();
}
  /**
 * Livestream Clip Creator
 * Frontend JavaScript
 */

// API and Socket.IO Configuration
const API_BASE_URL = '/api';
let API_KEY = localStorage.getItem('api_key') || '';
let socket = null;

// Current State
let currentCaptureJob = null;
let currentClipJob = null;
let timeSlider = null;
let maxDuration = 240; // 4 minutes in seconds
let previewFrames = [];
let currentClip = null;

// DOM Ready
$(document).ready(function() {
  // Check for API Key
  if (!API_KEY) {
    showApiKeyModal();
  } else {
    initializeApp();
  }
  
  // API Key Modal Handler
  $('#save-api-key').on('click', function() {
    const apiKey = $('#api-key-input').val().trim();
    if (apiKey) {
      API_KEY = apiKey;
      localStorage.setItem('api_key', apiKey);
      $('#api-key-modal').modal('hide');
      initializeApp();
    } else {
      $('#api-key-error').removeClass('d-none');
    }
  });
});

// Initialize the application
function initializeApp() {
  // Connect to Socket.IO
  connectSocket();
  
  // Initialize Time Slider
  initTimeSlider();
  
  // Load Initial Data
  loadLiveStreamers();
  loadClips();
  
  // Setup Event Listeners
  setupEventListeners();
}

// Connect to Socket.IO
function connectSocket() {
  // Initialize Socket.IO connection
  socket = io();
  
  // Socket Event Handlers
  socket.on('connect', function() {
    console.log('Connected to server');
    showToast('Connected to server', 'success');
  });
  
  socket.on('disconnect', function() {
    console.log('Disconnected from server');
    showToast('Disconnected from server', 'error');
  });
  
  socket.on('error', function(data) {
    console.error('Socket error:', data);
    showToast(data.message, 'error');
  });
  
  // Live Streamers Update
  socket.on('live_streamers', function(streamers) {
    renderLiveStreamers(streamers);
  });
  
  // Job Updates
  socket.on('job_updates', function(jobs) {
    updateJobsList(jobs);
    
    // Update current capture job if exists
    if (currentCaptureJob) {
      const job = jobs.find(j => j.id === currentCaptureJob.id);
      if (job) {
        currentCaptureJob = job;
        updateCaptureProgressUI(job);
      }
    }
    
    // Update current clip job if exists
    if (currentClipJob) {
      const job = jobs.find(j => j.id === currentClipJob.id);
      if (job) {
        currentClipJob = job;
        updateClipProgressUI(job);
      }
    }
  });
  
  // Capture Complete
  socket.on('capture_complete', function(data) {
    if (currentCaptureJob && currentCaptureJob.id === data.clipId) {
      showToast('Capture completed successfully!', 'success');
      $('#capture-progress-container').addClass('d-none');
      $('#clip-editor').removeClass('d-none');
      
      // Update max duration
      maxDuration = data.duration;
      
      // Reset time slider
      updateTimeSlider(0, maxDuration, 0, 30);
    }
  });
  
  // Capture Error
  socket.on('capture_error', function(data) {
    if (currentCaptureJob && currentCaptureJob.id === data.clipId) {
      showToast(`Capture failed: ${data.error}`, 'error');
      $('#capture-progress-container').addClass('d-none');
      $('#start-capture').prop('disabled', false);
    }
  });
  
  // Preview Complete
  socket.on('preview_complete', function(data) {
    if (currentCaptureJob && currentCaptureJob.id === data.clipId) {
      showToast('Preview frames generated!', 'success');
      loadPreviewFrames(data.clipId, data.frames);
    }
  });
  
  // Preview Error
  socket.on('preview_error', function(data) {
    if (currentCaptureJob && currentCaptureJob.id === data.clipId) {
      showToast(`Preview generation failed: ${data.error}`, 'error');
      $('#generate-previews').prop('disabled', false);
    }
  });
  
  // Clip Complete
  socket.on('clip_complete', function(data) {
    if (currentClipJob && currentClipJob.id === data.clipId) {
      showToast('Clip created successfully!', 'success');
      $('#clip-progress-container').addClass('d-none');
      
      // Reload clips and show the new clip
      loadClips(function() {
        loadClipDetails(currentClipJob.id);
      });
    }
  });
  
  // Clip Error
  socket.on('clip_error', function(data) {
    if (currentClipJob && currentClipJob.id === data.clipId) {
      showToast(`Clip creation failed: ${data.error}`, 'error');
      $('#clip-progress-container').addClass('d-none');
      $('#create-clip').prop('disabled', false);
    }
  });
  
  // Upload Complete
  socket.on('upload_complete', function(data) {
    if (currentClip && currentClip.id === data.clipId) {
      showToast('Clip uploaded successfully!', 'success');
      $('#upload-progress-container').addClass('d-none');
      $('#upload-clip').prop('disabled', false);
      
      // Update clip URL
      $('#clip-url').val(data.url);
      $('#upload-clip').addClass('d-none');
      
      // Reload clips to update URL
      loadClips();
    }
  });
  
  // Upload Error
  socket.on('upload_error', function(data) {
    if (currentClip && currentClip.id === data.clipId) {
      showToast(`Upload failed: ${data.error}`, 'error');
      $('#upload-progress-container').addClass('d-none');
      $('#upload-clip').prop('disabled', false);
    }
  });
  
  // Refresh Complete
  socket.on('refresh_complete', function(data) {
    if (data.all || data.platform) {
      showToast('Refresh completed successfully!', 'success');
    }
  });
}
