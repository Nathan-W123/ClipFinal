// Push-to-activate voice capture. Stop → STT + parse → review → SQLite + Supabase.

import React, { useState, useCallback } from 'react';
import { View, Pressable, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { useSQLiteContext } from 'expo-sqlite';
import * as Haptics from 'expo-haptics';
import { useVoiceParser } from '../voice/useVoiceParser';
import { startRecording, stopRecording, requestMicPermission, type ActiveRecording } from '../voice/audio';
import { insertCapture } from '../db/capturesRepository';
import { trySyncCaptures } from '../services/syncCaptures';
import { validateRecord } from '../core/validation';
import { Images } from '../assets/images';
import type { Template, ClipRecord } from '../core/schemas';
import type { ParseResult } from '../voice/cactus';
import { randomUuid } from '../utils/randomUuid';
import { ParsedPreview } from './ParsedPreview';

interface Props {
  template: Template;
  onSaved?: (record: ClipRecord) => void;
}

type CaptureState = 'idle' | 'recording' | 'parsing' | 'review' | 'saving';

export function VoiceCapture({ template, onSaved }: Props) {
  const db = useSQLiteContext();
  const { isReady, isLoading, downloadProgress, parseVoice, error: modelError } = useVoiceParser();
  const [captureState, setCaptureState] = useState<CaptureState>('idle');
  const [activeRecording, setActiveRecording] = useState<ActiveRecording | null>(null);
  const [pendingResult, setPendingResult] = useState<ParseResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handlePress = useCallback(async () => {
    setErrorMsg(null);

    if (captureState === 'idle') {
      const granted = await requestMicPermission();
      if (!granted) {
        setErrorMsg('Microphone permission denied — enable it in Settings');
        return;
      }
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      setCaptureState('recording');
      try {
        const rec = await startRecording();
        setActiveRecording(rec);
      } catch (e) {
        setErrorMsg('Microphone unavailable');
        setCaptureState('idle');
      }
      return;
    }

    if (captureState === 'recording' && activeRecording) {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setCaptureState('parsing');
      try {
        const uri = await stopRecording(activeRecording);
        setActiveRecording(null);
        const result = await parseVoice(uri, template);
        if (!result) {
          setErrorMsg('Could not parse — try again');
          setCaptureState('idle');
          return;
        }
        // Route to review so the user can inspect issues before saving.
        setPendingResult(result);
        setCaptureState('review');
      } catch (e) {
        setErrorMsg(`Capture failed: ${e instanceof Error ? e.message : String(e)}`);
        setCaptureState('idle');
      }
    }
  }, [captureState, activeRecording, parseVoice, template]);

  const handleConfirm = useCallback(async () => {
    if (!pendingResult) return;
    setCaptureState('saving');
    const hasErrors = (pendingResult.issues ?? []).some(i => i.severity === 'error');
    const record: ClipRecord = {
      id: randomUuid(),
      templateId: pendingResult.record.templateId,
      templateName: pendingResult.record.templateName,
      payload: pendingResult.record.payload,
      rawTranscript: pendingResult.record.rawTranscript,
      confidenceScore: pendingResult.confidence,
      validated: false,
      synced: false,
      capturedAt: new Date().toISOString(),
    };
    // validated = true only when there are no parser errors and base validation passes.
    record.validated = !hasErrors && validateRecord(record, template).valid;
    try {
      await insertCapture(db, record, 'voice_capture', null);
      await trySyncCaptures(db);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setPendingResult(null);
      setCaptureState('idle');
      onSaved?.(record);
    } catch (e) {
      setErrorMsg(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
      setCaptureState('review');
    }
  }, [pendingResult, db, onSaved, template]);

  const handleDiscard = useCallback(() => {
    setPendingResult(null);
    setCaptureState('idle');
  }, []);

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#000" />
        <Text style={styles.statusText}>
          Loading AI models… {Math.round(downloadProgress * 100)}%
        </Text>
      </View>
    );
  }

  if (!isReady) {
    return (
      <View style={styles.center}>
        <Text style={styles.statusText}>AI models not ready</Text>
        {modelError ? <Text style={styles.error}>{modelError}</Text> : null}
      </View>
    );
  }

  // Review step — show parsed result with issues before saving.
  if (captureState === 'review' && pendingResult) {
    return (
      <ParsedPreview
        result={pendingResult}
        template={template}
        onConfirm={handleConfirm}
        onDiscard={handleDiscard}
      />
    );
  }

  const isRecording = captureState === 'recording';
  const isParsing = captureState === 'parsing';
  const isSaving = captureState === 'saving';
  const isBusy = isParsing || isSaving;

  return (
    <View style={styles.container}>
      <Pressable
        style={[styles.button, isRecording && styles.buttonRecording]}
        onPress={handlePress}
        disabled={isBusy}
      >
        {isBusy ? (
          <ActivityIndicator color="#fff" size="large" />
        ) : isRecording ? (
          <View style={styles.dotRecording} />
        ) : (
          <Images.MicIcon width={32} height={40} />
        )}
      </Pressable>

      <Text style={styles.label}>
        {isSaving
          ? 'Saving…'
          : isParsing
            ? 'Transcribing & parsing…'
            : isRecording
              ? 'Recording — tap to stop'
              : 'Tap to record'}
      </Text>

      {errorMsg && <Text style={styles.error}>{errorMsg}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    gap: 16,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  button: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonRecording: {
    backgroundColor: '#E53935',
  },
  dotRecording: {
    width: 16,
    height: 16,
    borderRadius: 2,
  },
  label: {
    fontSize: 15,
    fontWeight: '500',
    color: '#555',
    letterSpacing: 0.2,
  },
  statusText: {
    fontSize: 14,
    color: '#888',
  },
  error: {
    fontSize: 13,
    color: '#E53935',
  },
});
