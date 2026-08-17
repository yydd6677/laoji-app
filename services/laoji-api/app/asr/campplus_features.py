"""Feature extraction for the workspace-local CAM++ speaker model."""

import torch
import torchaudio.compliance.kaldi as kaldi


def _pad_list(tensors, pad_value=0.0):
    max_length = max(tensor.size(0) for tensor in tensors)
    shape = (len(tensors), max_length, *tensors[0].size()[1:])
    padded = tensors[0].new_full(shape, pad_value)
    for index, tensor in enumerate(tensors):
        padded[index, : tensor.size(0)] = tensor
    return padded


def extract_feature(audio):
    features = []
    feature_times = []
    feature_lengths = []
    for waveform in audio:
        feature = kaldi.fbank(waveform.unsqueeze(0), num_mel_bins=80)
        feature = feature - feature.mean(dim=0, keepdim=True)
        features.append(feature)
        feature_times.append(waveform.shape[0])
        feature_lengths.append(feature.shape[0])
    return _pad_list(features), feature_lengths, feature_times
